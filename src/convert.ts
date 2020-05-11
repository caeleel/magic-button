export async function convert(node: DocumentNode): Promise<string> {
  return await convertNode(node)
}

async function convertNode(node: BaseNode): Promise<string> {
  switch (node.type) {
    case "DOCUMENT":
      return await convertDocument(node)

    case "PAGE":
      return await convertPage(node)

    case "SLICE":
      return ""

    case "FRAME":
    case "GROUP":
    case "COMPONENT":
    case "INSTANCE":
      return await convertFrame(node)

    case "BOOLEAN_OPERATION":
    case "VECTOR":
    case "STAR":
    case "LINE":
    case "ELLIPSE":
    case "POLYGON":
      return await convertShape(node)

    case "RECTANGLE":
      return await convertRectangle(node)

    case "TEXT":
      return await convertText(node)
  }
}

async function convertChildren(children: ReadonlyArray<BaseNode>): Promise<string> {
  return (await Promise.all(children.map(convertNode))).join("\n")
}

async function convertDocument(node: DocumentNode): Promise<string> {
  return `<div>
    ${await convertChildren(node.children)}
  </div>`
}

async function convertPage(node: PageNode): Promise<string> {
  return `<div>
    ${await convertChildren(node.children)}
  </div>`
}

async function convertFrame(node: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
  return `<div>
    ${await convertChildren(node.children)}
  </div>`
}

function arrayBufferToString(buffer: ArrayBuffer): string {
  return String.fromCharCode.apply(null, new Uint16Array(buffer) as any as number[])
}

async function convertRectangle(node: RectangleNode): Promise<string> {
  return `<div></div>`
}

async function convertShape(node: DefaultShapeMixin): Promise<string> {
  try {
    const svg = await node.exportAsync({format: 'SVG'})
    return arrayBufferToString(svg)
  } catch(e) {
    console.error("Failed to convert shape", node, e)
    return ""
  }
}

function convertText(node: TextNode): string {
  return `<div>
    ${node.characters}
  </div>`
}

type CSS = {[key: string]: string}

function getLayoutStyle(node: BaseNode): CSS {
  return {}
}