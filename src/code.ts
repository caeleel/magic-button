function main() {
  figma.showUI(__html__);
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
