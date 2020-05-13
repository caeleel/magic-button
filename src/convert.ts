export interface ImageToUpload {
  path: string
  bytes: Uint8Array
}

export interface FontInUse {
  name: string
}

export interface ConversionResult {
  pageData: PageData
  images: {[hash: string]: ImageToUpload}
  fonts: {[name: string]: boolean}
}

export type PageData = {[path: string]: string}

function mergePageData(a: PageData, b: PageData) {
  return {...a, ...b}
}

function toStyleString(style: CSS): string {
  return Object.keys(style).map(key => {
    return `${key}: ${style[key]}`
  }).join(`;`)
}

function h(tagName: string, name: string, style: CSS, layout: Layout, content: string) {
  // TODO(jlfwong): Remove the name=... for debugging
  return `<div class="outerDiv" style='${toStyleString(layout.outer)}'><${tagName} class="innerDiv" name="${name}" style='${toStyleString({ ...layout.inner, ...style })}'>${content}</${tagName}></div>`
}

let images: ConversionResult["images"]
let fonts: ConversionResult["fonts"]

export async function convert(node: DocumentNode): Promise<ConversionResult> {
  images = {}
  fonts = {}
  const pageData = await convertDocument(node)
  return {pageData, images, fonts}
}

async function convertNode(node: BaseNode): Promise<string> {
  if ('visible' in node && !node.visible) {
    return ""
  }

  switch (node.type) {
    case "DOCUMENT":
    case "PAGE":
      throw new Error(`Unexpected type ${node.type} in convertNode`)

    case "SLICE":
    case "GROUP":
      return ""

    case "FRAME":
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
  const allChildren: BaseNode[] = []
  function appendChildren(children: ReadonlyArray<BaseNode>) {
    for (const child of children) {
      if (child.type !== "GROUP") allChildren.push(child)
      else if (child.visible) appendChildren(child.children)
    }
  }
  appendChildren(children)

  return (await Promise.all(allChildren.map(convertNode))).join("\n")
}

async function convertDocument(node: DocumentNode): Promise<PageData> {
  const perPageData = await Promise.all(node.children.map(convertPage))
  let data: PageData = {}
  for (let page of perPageData) {
    data = mergePageData(data, page)
  }
  return data
}

async function convertPage(node: PageNode): Promise<PageData> {
  let data: PageData = {}
  for (let child of node.children) {
    if (child.type === "INSTANCE" || child.type === "COMPONENT" || child.type === "FRAME") {
      data[child.name] = await convertTopLevelFrame(child)
    }
  }
  return data
}

async function convertTopLevelFrame(node: FrameNode | ComponentNode | InstanceNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...await getBackgroundStyleForPaints('fills' in node ? defaultForMixed(node.fills, []) : []),
  }

  // TODO(jlfwong): This isn't actually what we want -- we just want this to
  // contain all the children.
  const layout: Layout = {
    inner: { width: '100%' },
    outer: {
      position: "relative",
      top: 0,
      left: 0,
      width: '100%',
      height: '100vh',
    }
  }

  return h("div", node.name, style, layout, await convertChildren(node.children))
}

async function convertFrame(node: FrameNode | ComponentNode | InstanceNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...await getBackgroundStyleForPaints('fills' in node ? defaultForMixed(node.fills, []) : []),
  }
  const layout = getLayoutStyle(node)

  const usePlaceholder = node.constraints.horizontal !== "STRETCH"
  const children = await convertChildren(node.children)
  const content = usePlaceholder ? `<div style="width: ${layout.inner.width}; height: ${node.height}px"></div>` + children : children
  return h("div", node.name, style, layout, content)
}

function arrayBufferToString(buffer: ArrayBuffer): string {
  return String.fromCharCode.apply(null, new Uint16Array(buffer) as any as number[])
}

async function convertRectangle(node: RectangleNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...await getBackgroundStyleForPaints(defaultForMixed(node.fills, [])),
  }
  const layout = getLayoutStyle(node)
  const usePlaceholder = node.constraints.horizontal !== "STRETCH"
  return h("div", node.name, style, layout, usePlaceholder ? `<div style="width: ${layout.inner.width}; height: ${node.height}px"></div>` : "")
}

async function convertShape(node: BaseNode & DefaultShapeMixin): Promise<string> {
  // We don't include opacity here because it gets baked into the node

  try {
    const svg = await node.exportAsync({format: 'SVG'})
    return h("div", node.name, {}, getLayoutStyle(node), arrayBufferToString(svg))
  } catch(e) {
    console.error("Failed to convert shape", node, e)
    return ""
  }
}

function colorToCSS(rgb: RGB, opacity: number) {
  const {r,g,b} = rgb
  return `rgba(${255.0 * r}, ${255.0 * g}, ${255.0 * b}, ${opacity})`
}

function colorFromPaints(fills: ReadonlyArray<Paint>): string | null {
  const firstColor = fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint
  if (firstColor == null) return null
  return colorToCSS(firstColor.color, firstColor.opacity || 1.0)
}

function defaultForMixed<T>(t: T | PluginAPI['mixed'], defaultVal: T): T {
  return t === figma.mixed ? defaultVal  : t
}

function numericWeightFromStyle(style: string): number {
  // TODO(jlfwong): This is a crummy heuristic that'll be wrong in a variety of
  // circumstances. It would be better if the plugin APIs exposed the numeric
  // font weight.
  //
  // For example, Inter Regular seems to match up with weight 300 from Google
  // Fonts? This is maybe a versioning issue.
  switch (style.replace(/\s*italic\s*/i, "")) {
    case "Thin":
      return 100

    case "Extra Light":
    case "Extra-light":
      return 200

    case "Light":
      return 300

    case "Regular":
      return 400

    case "Medium":
      return 500

    case "Semi Bold":
    case "Semi-bold":
      return 600

    case "Bold":
      return 700

    case "Extra Bold":
    case "Extra-bold":
      return 800

    case "Black":
      return 900
  }
  return 400
}

function convertText(node: TextNode): string {
  // TODO(jlfwong): Handle text with character overrides

  const style = {
    ...getOpacityStyle(node),
  }
  const color = colorFromPaints(defaultForMixed(node.fills, []))
  if (color != null) {
    style['color'] = color
  }

  const fontName = defaultForMixed(node.fontName, null)
  node.absoluteTransform
  if (fontName != null) {
    let fontWeightNumeric = numericWeightFromStyle(fontName.style)
    let italic = (/italic/i).exec(fontName.style) != null

    const googleFontName = `${fontName.family}:${italic ? 'ital,' : ''}wght@${fontWeightNumeric}`
    fonts[googleFontName] = true
    style['font-family'] = `"${fontName.family}"`
    if (fontWeightNumeric !== 400) {
      style['font-weight'] = `${fontWeightNumeric}`
    }
    if (italic) {
      style['font-style'] = 'italic'
    }
  }

  const fontSize = defaultForMixed(node.fontSize, null)
  if (fontSize != null) {
    style['font-size'] = `${fontSize}px`
  }

  style['text-align'] = node.textAlignHorizontal.toLowerCase()

  return h("div", node.name, style, getLayoutStyle(node), node.characters)
}

type CSS = { [key: string]: string | number }

type Layout = {
  inner: CSS
  outer: CSS
}

const emptyLayout = { inner: {}, outer: {} }

interface Bounds {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

function getLayoutStyle(node: BaseNode & LayoutMixin): Layout {
  const x = node.absoluteTransform[0][2]
  const y = node.absoluteTransform[1][2]

  let parent = node.parent as BaseNode & LayoutMixin
  while (parent.type === "GROUP") {
    parent = parent.parent as BaseNode & LayoutMixin
  }

  const px = parent.absoluteTransform[0][2]
  const py = parent.absoluteTransform[1][2]

  let bounds: Bounds | null = null

  if (parent) {
    bounds = {
      left: x - px,
      right: px + parent.width - (x + node.width),
      top: y - py,
      bottom: py + parent.height - (y + node.height),
      width: node.width,
      height: node.height,
    }
  }

  let candidate = node as BaseNode & ChildrenMixin
  while (!('constraints' in candidate)) {
    candidate = candidate.children[0] as BaseNode & ChildrenMixin
  }
  const cHorizontal = (candidate as ConstraintMixin).constraints.horizontal
  const inner: { [key: string]: number | string } = {}
  const outer: { [key: string]: number | string } = {}

  if (cHorizontal === "STRETCH") {
    if (bounds != null) {
      inner["margin-left"] = `${bounds.left}px`
      inner["margin-right"] = `${bounds.right}px`
      inner["flex-grow"] = 1
    }
  } else if (cHorizontal === "MAX") {
    outer["justify-content"] = "flex-end"
    if (bounds != null) {
      inner["margin-right"] = `${bounds.right}px`
      inner["width"] = `${bounds.width}px`
      inner["min-width"] = `${bounds.width}px`
    }
  } else if (cHorizontal === "CENTER") {
    outer["justify-content"] = "center"
    if (bounds != null) {
      inner["width"] = `${bounds.width}px`
      if (bounds.left && bounds.right) inner["margin-left"] = `${bounds.left - bounds.right}px`
    }
  } else if (cHorizontal === "SCALE") {
    if (bounds != null) {
      const parentWidth = bounds.left + bounds.width + bounds.right
      inner["width"] = `${bounds.width * 100 / parentWidth}%`
      inner["margin-left"] = `${bounds.left * 100 / parentWidth}%`
    }
  } else {
    if (bounds != null) {
      inner["margin-left"] = `${bounds.left}px`
      inner["width"] = `${bounds.width}px`
      inner["min-width"] = `${bounds.width}px`
    }
  }

  if (bounds != null) {
    inner["margin-top"] = `${bounds.top}px`
    inner["margin-bottom"] = `${bounds.bottom}px`
    inner["min-height"] = `${bounds.height}px`
  }

  return { inner, outer }
}

function getOpacityStyle(node: BlendMixin): CSS {
  if (node.opacity === 1) return {}
  return {
    opacity: `${node.opacity}`
  }
}

async function getBackgroundStyleForPaints(paints: ReadonlyArray<Paint>): Promise<CSS> {
  const ret: CSS = {}

  const backgroundParts: string[] = []

  for (let paint of paints) {
    if (!paint.visible) continue

    switch (paint.type) {
      case "SOLID": {
        backgroundParts.push(colorToCSS(paint.color, paint.opacity || 1.0))
        break
      }

      case "IMAGE": {
        const hash = paint.imageHash
        if (hash != null) {
          const img = figma.getImageByHash(hash)
          const bytes = await img.getBytesAsync()

          // TODO(jlfwong): Support images other than .pngs
          const path = `/images/${hash}.png`
          backgroundParts.push(`url(${path}) no-repeat top left/contain`)
          images[hash] = {bytes, path}
        }
      }

      case "GRADIENT_LINEAR":
      case "GRADIENT_RADIAL":
      case "GRADIENT_DIAMOND":
      case "GRADIENT_ANGULAR": {
        // TODO(jlfwong): Handle gradients
      }
    }
  }

  if (backgroundParts.length > 0) {
    ret['background'] = backgroundParts.join(",")
  }

  return ret
}
