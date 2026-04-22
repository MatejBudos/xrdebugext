import * as vscode from "vscode";
import * as net from "net";
import * as dgram from "dgram";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const AST_PROXY_PORT = 4720;
const DISCOVERY_PORT = 37020;
const BEACON = "XRDEBUG_HERE";

let astProxyHost: string | null = null;
let discoverySocket: dgram.Socket | null = null;

let client: net.Socket | null = null;
let connected = false;
let innitMessage: string = JSON.stringify({ type: "id", content: "Extension" }) + '\n';
const messageQueue: string[] = [];
let currentPath: string = "";
let currentRoot: string = "";

function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        const ifaces = interfaces[name];
        if (!ifaces) { continue; }
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

function startDiscovery() {
    if (discoverySocket) { return; }

    discoverySocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    discoverySocket.on("message", (msg, rinfo) => {
        if (msg.toString().trim() !== BEACON) { return; }
        const backendIP = rinfo.address;
        console.log(`[Discovery] Backend found at ${backendIP}`);
        if (astProxyHost === backendIP) { return; }

        astProxyHost = backendIP;
        if (client) {
            client.removeAllListeners("close");
            client.destroy();
            client = null;
        }
        connected = false;
        currentPath = "";
        currentRoot = "";
        initTcpConnection();
    });

    discoverySocket.on("error", (err) => {
        console.error("[Discovery] UDP error:", err);
        discoverySocket = null;
        setTimeout(startDiscovery, 5000);
    });

    discoverySocket.bind(DISCOVERY_PORT, () => {
        console.log(`[Discovery] Listening on UDP port ${DISCOVERY_PORT}`);
    });
}

async function updateLaunchJsonHost(workspaceFolder: vscode.WorkspaceFolder) {
    const launchPath = path.join(workspaceFolder.uri.fsPath, ".vscode", "launch.json");
    if (!fs.existsSync(launchPath)) { return; }

    const localIP = getLocalIP();
    try {
        const content = fs.readFileSync(launchPath, "utf-8");
        const updated = content.replace(/"host"\s*:\s*"[^"]*"/g, `"host": "${localIP}"`);
        if (updated !== content) {
            fs.writeFileSync(launchPath, updated, "utf-8");
            console.log(`[Discovery] Updated launch.json host to ${localIP}`);
        }
    } catch (e) {
        console.error("Failed to update launch.json:", e);
    }
}

function sendPath(path: string) {
    const message = JSON.stringify({ type: "path", content: path }) + "\n";
    if (currentPath !== path){
        currentPath = path;
        sendMessage(message);
    }
}

function sendWorkspaceRoot(path: string) {
    const message = JSON.stringify({ type: "projectRoot", content: path }) + "\n";
    if (currentRoot !== path){
        currentRoot = path;
        sendMessage(message);
    }
}

function sendMessage(msg: string) {
    if (connected && client) {
        client.write(msg);
    } else {
        messageQueue.push(msg);
    }
}

function addBreakpoint(filePath: string, line: number) {
    const uri = vscode.Uri.file(filePath);
    const position = new vscode.Position(line - 1, 0); // VS Code je 0-indexed
    const location = new vscode.Location(uri, position);
    const breakpoint = new vscode.SourceBreakpoint(location, true);

    vscode.debug.addBreakpoints([breakpoint]);
    console.log(`Breakpoint added at ${filePath}:${line}`);
}

function removeBreakpoint(filePath: string, line: number) {
    const existing = vscode.debug.breakpoints.filter(bp => {
        if (bp instanceof vscode.SourceBreakpoint) {
            return bp.location.uri.fsPath === filePath &&
                   bp.location.range.start.line === line - 1;
        }
        return false;
    });

    vscode.debug.removeBreakpoints(existing);
    console.log(`Breakpoint removed at ${filePath}:${line}`);
}

function initTcpConnection() {
    if (!astProxyHost) {
        console.log("[Discovery] No backend IP yet, waiting for UDP beacon...");
        return;
    }

    const host = astProxyHost;
    client = new net.Socket();

    client.connect(AST_PROXY_PORT, host, async () => {
        console.log(`Connected to AST proxy at ${host}:${AST_PROXY_PORT}`);
        connected = true;

        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            if (msg && client) {
                client.write(msg);
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            sendWorkspaceRoot(workspaceFolders[0].uri.fsPath);
        }
    });

    client.on("data", (data) => {
        console.log("Received from SERVER:", data.toString());

        try {
            const msg = JSON.parse(data.toString().trim());

            if (msg.type === "setBreakpoint") {
                addBreakpoint(msg.filePath, parseInt(msg.line));
            }
            if (msg.type === "removeBreakpoint") {
                removeBreakpoint(msg.filePath, parseInt(msg.line));
            }
        } catch (e) {
            console.error("Failed to parse message:", e);
        }
    });

    client.on("close", () => {
        console.log("SERVER connection closed, reconnecting in 2s...");
        connected = false;
        currentPath = "";
        currentRoot = "";
        if (astProxyHost) {
            setTimeout(initTcpConnection, 2000);
        }
    });

    client.on("error", (err) => {
        console.error("SERVER connection error:", err);
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log("XRDebugExt activated");

    startDiscovery();

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        sendWorkspaceRoot(workspaceFolders[0].uri.fsPath);
        updateLaunchJsonHost(workspaceFolders[0]);
    }

    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        if (event.added.length > 0) {
            sendWorkspaceRoot(event.added[0].uri.fsPath);
            updateLaunchJsonHost(event.added[0]);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) sendPath(editor.document.fileName);
    }, null, context.subscriptions);

    vscode.debug.onDidStartDebugSession(async (session) => {
        console.log("Debug session started:", session.name);

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            sendWorkspaceRoot(workspaceFolders[0].uri.fsPath);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const debugStartMsg = JSON.stringify({ type: "debugStart" }) + "\n";
        sendMessage(debugStartMsg);
        await new Promise(resolve => setTimeout(resolve, 100));

        const editor = vscode.window.activeTextEditor;
        if (editor?.document) {
            sendPath(editor.document.fileName);
        }
    }, null, context.subscriptions);

    vscode.debug.onDidTerminateDebugSession((session) => {
        console.log("Debug session terminated:", session.name);
        const debugStopMsg = JSON.stringify({ type: "debugStop" }) + "\n";
        sendMessage(debugStopMsg);
    }, null, context.subscriptions);
}

export function deactivate() {
    if (client) {
        client.end();
        client.destroy();
        client = null;
    }
    if (discoverySocket) {
        discoverySocket.close();
        discoverySocket = null;
    }
    connected = false;
}