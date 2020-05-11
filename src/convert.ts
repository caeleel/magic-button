function toStyleString(style: CSS): string {
  return Object.keys(style).map(key => {
    return `${key}: ${style[key]}`
  }).join(`;`)
}

function h(tagName: string, name: string, style: CSS, content: string) {
  // TODO(jlfwong): Remove the name=... for debugging
  return `<${tagName} name="${name}" style="${toStyleString(style)}">${content}</${tagName}>`
}

export async function convert(node: DocumentNode): Promise<string> {
  return await convertNode(node)
}

async function convertNode(node: BaseNode): Promise<string> {
  if ('visible' in node && !node.visible) {
    return ""
  }

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
  return h("div", node.name, {}, await convertChildren(node.children))
}

async function convertPage(node: PageNode): Promise<string> {
  return h("div", node.name, {}, await convertChildren(node.children))
}

async function convertFrame(node: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
  const shouldWrapChildrenWithLayout = node.parent?.type !== "PAGE" && node.type !== "GROUP"

  const style = {
    ...getOpacityStyle(node),
    ...(shouldWrapChildrenWithLayout ? getLayoutStyle(node) : {})
  }
  return h("div", node.name, style, await convertChildren(node.children))
}

function arrayBufferToString(buffer: ArrayBuffer): string {
  return String.fromCharCode.apply(null, new Uint16Array(buffer) as any as number[])
}

async function convertRectangle(node: RectangleNode): Promise<string> {
  const style = {
    ...getOpacityStyle(node),
    ...getLayoutStyle(node)
  }
  return h("div", node.name, style, "")
}

async function convertShape(node: BaseNode & DefaultShapeMixin): Promise<string> {
  // We don't include opacity here because it gets baked into the node
  const style = getLayoutStyle(node)
  try {
    const svg = await node.exportAsync({format: 'SVG'})
    return h("div", node.name, style, arrayBufferToString(svg))
  } catch(e) {
    console.error("Failed to convert shape", node, e)
    return ""
  }
}

function colorFromPaints(fills: ReadonlyArray<Paint>): string | null {
  const firstColor = fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint
  if (firstColor === null) return null
  const {r,g,b} = firstColor.color
  return `rgba(${255.0 * r}, ${255.0 * g}, ${255.0 * b}, ${firstColor.opacity})`
}

function defaultForMixed<T>(t: T | PluginAPI['mixed'], defaultVal: T): T {
  return t === figma.mixed ? defaultVal  : t
}

function convertText(node: TextNode): string {
  // TODO(jlfwong): Handle text with character overrides

  const style = {
    ...getOpacityStyle(node),
    ...getLayoutStyle(node)
  }
  const color = colorFromPaints(defaultForMixed(node.fills, []))
  if (color != null) {
    style['color'] = color
  }

  const fontName = defaultForMixed(node.fontName, null)
  if (fontName != null) {
    style['font-family'] = fontName.family
  }

  const fontSize = defaultForMixed(node.fontSize, null)
  if (fontSize != null) {
    style['font-size'] = `${fontSize}px`
  }

  return h("div", node.name, style, node.characters)
}

type CSS = {[key: string]: string}

function getLayoutStyle(node: BaseNode & LayoutMixin): CSS {
  const {x, y, width, height} = node
  return {
    position: "absolute",
    left: `${x.toFixed(0)}px`,
    top: `${y.toFixed(0)}px`,
    width: `${width.toFixed(0)}px`,
    height: `${height.toFixed(0)}px`
  }
}

function getOpacityStyle(node: BlendMixin): CSS {
  return {
    opacity: `${node.opacity}`
  }
}