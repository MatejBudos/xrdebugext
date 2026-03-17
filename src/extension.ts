import * as vscode from "vscode";
import * as net from "net";
import console from "console";


const AST_PROXY_HOST = "192.168.0.185";
const AST_PROXY_PORT = 4720;

let client: net.Socket | null = null;
let connected = false;
const messageQueue: string[] = [JSON.stringify({ type: "id", content: "Extension" })];
let currentPath: string = "";

// Odoslanie správy alebo bufferovanie
function sendPath(path: string) {
    const message = JSON.stringify({ type: "path", content: path }) + "\n";
    currentPath = path;
    sendMessage(message);
    
}


function sendMessage(msg: string){
    if (connected && client) {
        client.write(msg);
    } else {
        messageQueue.push(msg);
    }

}

// Inicializácia TCP spojenia s reconnect logikou
function initTcpConnection() {
    client = new net.Socket();

    client.connect(AST_PROXY_PORT, AST_PROXY_HOST, () => {
        console.log(`Connected to AST proxy at ${AST_PROXY_HOST}:${AST_PROXY_PORT}`);
        connected = true;

        // Odoslať všetky správy z queue
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            if (msg && client) {
                client.write(msg);
            }
        }
    });

    client.on("data", (data) => {
        console.log("Received from SERVER:", data.toString());
    });

    client.on("close", () => {
        console.log("SERVER connection closed, reconnecting in 2s...");
        connected = false;
        setTimeout(initTcpConnection, 2000);
    });

    client.on("error", (err) => {
        console.error("SERVER connection error:", err);
    });
}

// Aktivácia extension
export function activate(context: vscode.ExtensionContext) {
    console.log("XRDebugExt activated");

    initTcpConnection();

    // Posielanie cesty pri prepnutí editoru
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) sendPath(editor.document.fileName);
    }, null, context.subscriptions);

    vscode.debug.onDidStartDebugSession((session) => {
    console.log("Debug session started:", session.name);

    // napr. pošli aktuálny otvorený súbor
    const editor = vscode.window.activeTextEditor;
    if (editor?.document) {
        sendPath(editor.document.fileName);
    }
    

}, null, context.subscriptions);

}

// Deaktivácia extension
export function deactivate() {
    if (client) {
        client.end();
        client.destroy();
        client = null;
    }
    connected = false;
}
