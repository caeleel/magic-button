import { convert } from "./convert";

async function run() {
  try {
    const result = await convert(figma.root)
    figma.ui.postMessage(result)
    console.log("done")
  } catch(e) {
    console.error("Conversion failed", e)
  }
}

function main() {
  figma.showUI(__html__, {width: 360, height: 640});
  run()

  sendToNetlify({ paths: new Map(), blobs: new Map() });
}

interface PackagedWebsite {
  // Map from hash to blob key
  paths: Map<string, string>

  // Map from blob key to binary
  blobs: Map<string, Uint8Array>
}

async function sendToNetlify(website: PackagedWebsite) {
  const token: string | undefined = await figma.clientStorage.getAsync("netlify_token");
  if (token == null) {
    figma.ui.on("message", (message) => {
      if (message.type === "token-response") {
        figma.clientStorage.setAsync("netlify_token", message.token);
      }
    });
  } else {
    figma.ui.postMessage({ type: "token", token });
  }
}

main();
