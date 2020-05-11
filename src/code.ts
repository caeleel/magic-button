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
}

interface PackagedWebsite {
  // Map from hash to blob key
  paths: Map<string, string>

  // Map from blob key to binary
  blobs: Map<string, Uint8Array>
}

function sendToNetlify(website: PackagedWebsite) {
}

main();
