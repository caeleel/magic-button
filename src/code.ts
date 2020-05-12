import { convert } from "./convert";

async function run() {
  try {
    const result = await convert(figma.root)
    figma.ui.postMessage({
      type: "conversion-result",
      content: result
    })
  } catch(e) {
    console.error("Conversion failed", e)
  }
}

function main() {
  figma.showUI(__html__, {width: 360, height: 640});
  run()

  sendToNetlify();
}

async function sendToNetlify() {
  const token: string | undefined = await figma.clientStorage.getAsync("netlify_token");
  const siteId: string = figma.root.getPluginData("netlify_site_id");

  figma.ui.on("message", (message) => {
    if (message.type === "token-response") {
      figma.clientStorage.setAsync("netlify_token", message.token);
    } else if (message.type === "netlify-site") {
      figma.root.setPluginData("netlify_site_id", message.site_id);
    }
  });

  figma.ui.postMessage({ type: "init", token: token || "", siteId });
}

main();
