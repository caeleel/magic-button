export interface ImageToUpload {
  path: string
  bytes: Uint8Array
}

export interface FontInUse {
  name: string
}

export interface ConversionResult {
  frameIdToHtml: {[id: string]: string}
  images: {[hash: string]: ImageToUpload}
  fonts: {[name: string]: boolean}
  startFrameId: string
  frameIdToPath: {[id: string]: string}
  actions: Action[]
}

function toStyleString(style: CSS): string {
  return Object.keys(style).map(key => {
    return `${key}: ${style[key]}`
  }).join(`;`)
}

function h(tagName: string, name: string, style: CSS, layout: Layout, eventHandling: string, content: string) {
  // TODO(jlfwong): Remove the name=... for debugging
  return `<div class="${layout.outerClass}" style='${toStyleString(layout.outer)}'><${tagName} class="innerDiv" name="${name}" ${eventHandling} style='${toStyleString({ ...layout.inner, ...style })}'>${content}</${tagName}></div>`
}

let images: ConversionResult["images"]
let fonts: ConversionResult["fonts"]
let frameIdToPath: ConversionResult["frameIdToPath"]
let actions: ConversionResult["actions"]

function nameToPath(name: string): string {
  name = name.toLowerCase()
  return "/" + (name.endsWith(".html") ? name : name.replace(/\W+/g, "-") + "/index.html")
}

export async function convert(node: PageNode): Promise<ConversionResult> {
  images = {}
  fonts = {}
  frameIdToPath = {}
  actions = []

  // Build the routing table
  for (let pageChild of node.children) {
    switch (pageChild.type) {
      case "INSTANCE":
      case "COMPONENT":
      case "FRAME": {
        const path = nameToPath(pageChild.name)
        frameIdToPath[pageChild.id] = path
        break
      }
    }
  }

  let startFrame = node.prototypeStartNode
  if (startFrame == null) {
    // No prototype start node specified. Fall back to top-left-most node
    for (let pageChild of node.children) {
      switch (pageChild.type) {
        case "INSTANCE":
        case "COMPONENT":
        case "FRAME": {
          if (!startFrame) {
            startFrame = pageChild
          } else {
            if (pageChild.y < startFrame.y || (pageChild.y === startFrame.y && pageChild.x < startFrame.x)) {
              startFrame = pageChild
            }
          }
        }
      }
    }
  }

  if (startFrame == null) {
    throw new Error("No start frame found! Page must contain a frame!")
  }

  const frameIdToHtml = await convertPage(node)
  return {frameIdToHtml, images, fonts, frameIdToPath, startFrameId: startFrame.id, actions}
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
      return ""

    case "GROUP":
      return await convertAutolayoutGroup(node)

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
      else if (child.visible) {
        if (child.parent && 'layoutMode' in child.parent && child.parent.layoutMode !== "NONE") {
          allChildren.push(child)
        } else {
          appendChildren(child.children)
        }
      }
    }
  }
  appendChildren(children)

  return (await Promise.all(allChildren.map(convertNode))).join("\n")
}

async function convertPage(node: PageNode): Promise<ConversionResult["frameIdToHtml"]> {
  let data: ConversionResult["frameIdToHtml"] = {}
  for (let child of node.children) {
    if (child.type === "INSTANCE" || child.type === "COMPONENT" || child.type === "FRAME") {
      data[child.id] = await convertTopLevelFrame(child)
    }
  }
  return data
}

function eventHandlingAttributes(reactions: ReadonlyArray<Reaction>): string {
  let attributes = []

  for (let {trigger, action} of reactions) {
    let attr: string | null = null
    switch (trigger.type) {
      case "ON_CLICK":
        attr = "onclick"
        break

      case "MOUSE_DOWN":
        attr = "onpointerdown"
        break

      case "ON_PRESS":
      case "MOUSE_UP":
        attr = "onpointerup"
        break

      case "ON_HOVER":
        attr = "onmouseover"
        break
    }

    if (attr == null) continue

    const actionId = actions.length
    actions.push(action)
    attributes.push(`${attr}="magic_runAction(${actionId})"`)
  }

  return attributes.join(" ")
}

async function convertAutolayoutGroup(node: GroupNode): Promise<string> {
  const flexDirection = (node.parent! as FrameNode).layoutMode === "VERTICAL" ? "column" : "row"
  return `<div style="display: flex; flex-direction: ${flexDirection}">${await convertChildren(node.children)}</div>`
}

async function convertTopLevelFrame(node: FrameNode | ComponentNode | InstanceNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...await getBackgroundStyleForPaints('fills' in node ? defaultForMixed(node.fills, []) : []),
  }

  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"

  return `<body ${events} style="${toStyleString(style)}">${await convertChildren(node.children)}</body>`
}

async function convertFrame(node: FrameNode | ComponentNode | InstanceNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...getEffectsStyle(node),
    ...getRoundedRectangleStyle(node),
    ...await getStrokeStyleForPaints(node.strokeWeight, defaultForMixed(node.strokes, [])),
    ...await getBackgroundStyleForPaints('fills' in node ? defaultForMixed(node.fills, []) : []),
  }
  const layout = getLayoutStyle(node)

  const usePlaceholder = node.constraints.horizontal !== "STRETCH" && node.layoutMode === "NONE"
  const children = await convertChildren(node.children)
  const content = usePlaceholder ? `<div style="width: ${layout.inner.width}; height: ${node.height}px"></div>` + children : children

  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"
  return h("div", node.name, style, layout, events, content)
}

function arrayBufferToString(buffer: ArrayBuffer): string {
  return String.fromCharCode.apply(null, new Uint16Array(buffer) as any as number[])
}

async function convertRectangle(node: RectangleNode): Promise<string> {
  const style: CSS = {
    ...getOpacityStyle(node),
    ...getEffectsStyle(node),
    ...getRoundedRectangleStyle(node),
    ...await getStrokeStyleForPaints(node.strokeWeight, defaultForMixed(node.strokes, [])),
    ...await getBackgroundStyleForPaints(defaultForMixed(node.fills, [])),
  }
  const layout = getLayoutStyle(node)
  const usePlaceholder = node.constraints.horizontal !== "STRETCH"
  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"
  return h("div", node.name, style, layout, events, usePlaceholder ? `<div style="width: ${node.width}; height: ${node.height}px"></div>` : "")
}

async function convertShape(node: BaseNode & DefaultShapeMixin): Promise<string> {
  // We don't include opacity here because it gets baked into the node

  try {
    const svg = await node.exportAsync({format: 'SVG'})
    const events = eventHandlingAttributes(node.reactions)
    let style: CSS = {}
    if (events.length > 0) style["cursor"] = "pointer"
    return h("div", node.name, {}, getLayoutStyle(node), events, arrayBufferToString(svg))
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
    ...getEffectsStyle(node),
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

  style['text-align'] = node.textAlignHorizontal.toLowerCase()

  const fontSize = defaultForMixed(node.fontSize, null)
  if (fontSize != null) {
    style['font-size'] = `${fontSize}px`
  }

  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"
  return h("div", node.name, style, getLayoutStyle(node), events, `<div>${node.characters.replace("\n", "<br>")}</div>`)
}

type CSS = { [key: string]: string | number }

type Layout = {
  outerClass: string
  inner: CSS
  outer: CSS
}

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
  let outerClass = 'outerDiv'

  let parent = node.parent as BaseNode & LayoutMixin & ChildrenMixin
  let lastGroupParent: GroupNode | null = null
  let isFirstChild = parent.children.indexOf(node as SceneNode) === 0

  while (parent.type === "GROUP") {
    lastGroupParent = parent
    parent = parent.parent as BaseNode & LayoutMixin & ChildrenMixin
    if (!('layoutMode' in parent)) {
      isFirstChild = isFirstChild && (parent.children.indexOf(lastGroupParent) === 0)
    }
  }

  let px = parent.absoluteTransform[0][2]
  let py = parent.absoluteTransform[1][2]

  const bounds = {
    left: x - px,
    right: px + parent.width - (x + node.width),
    top: y - py,
    bottom: py + parent.height - (y + node.height),
    width: node.width,
    height: node.height,
  }

  let candidate = node as BaseNode & ChildrenMixin
  while (!('constraints' in candidate)) {
    candidate = candidate.children[0] as BaseNode & ChildrenMixin
  }

  const inner: { [key: string]: number | string } = {}
  const outer: { [key: string]: number | string } = {}

  let cHorizontal = (candidate as ConstraintMixin).constraints.horizontal
  let vHorizontal = (candidate as ConstraintMixin).constraints.vertical

  if ('layoutMode' in parent && parent.layoutMode === "VERTICAL") {
    cHorizontal = lastGroupParent ? lastGroupParent.layoutAlign : node.layoutAlign

    outerClass = "autolayoutVchild"

    if (lastGroupParent) {
      outer["padding-bottom"] = `${lastGroupParent.height - bounds.height - (node.y - lastGroupParent.y)}px`
    }

    if (!isFirstChild) {
      if (lastGroupParent && bounds) {
        outer["margin-top"] = `${-lastGroupParent.height + (node.y - lastGroupParent.y)}px`
      } else if (parent.constraints.vertical !== "STRETCH") {
        outer["margin-top"] = `${parent.itemSpacing}px`
      }
    } else if (parent.constraints.vertical !== "STRETCH" && lastGroupParent && lastGroupParent.parent!.children.indexOf(lastGroupParent) !== 0) {
      outer["margin-top"] = `${parent.itemSpacing}px`
    }

    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
      if (node.layoutMode === "NONE") {
        outer["min-height"] = `${bounds.height}px`
      }
    }
  } else if ('layoutMode' in parent && parent.layoutMode === "HORIZONTAL") {
    vHorizontal = lastGroupParent ? lastGroupParent.layoutAlign : node.layoutAlign

    outerClass = "autolayoutHchild"

    if (lastGroupParent) {
      outer["padding-right"] = `${lastGroupParent.width - bounds.width - (node.x - lastGroupParent.x)}px`
    }

    if (!isFirstChild) {
      if (lastGroupParent && bounds) {
        outer["margin-left"] = `${-lastGroupParent.width + (node.x - lastGroupParent.x)}px`
      } else if (parent.constraints.horizontal !== "STRETCH") {
        outer["margin-left"] = `${parent.itemSpacing}px`
      }
    } else if (parent.constraints.horizontal !== "STRETCH" && lastGroupParent && lastGroupParent.parent!.children.indexOf(lastGroupParent) !== 0) {
      outer["margin-left"] = `${parent.itemSpacing}px`
    }
  }

  if ('layoutMode' in node && node.layoutMode !== "NONE") {
    inner["display"] = "flex"
    if (node.layoutMode === "VERTICAL") {
      inner["flex-direction"] = "column"
      if (node.constraints.vertical === "STRETCH") {
        inner["justify-content"] = "space-between"
      }
      inner["padding"] = `${node.verticalPadding}px 0`
    } else {
      if (node.constraints.horizontal === "STRETCH") {
        inner["justify-content"] = "space-between"
      }
      inner["padding"] = `0 ${node.horizontalPadding}px`
    }
  }

  if (outerClass !== "autolayoutHchild") {
    if (cHorizontal === "STRETCH") {
      inner["margin-left"] = `${bounds.left}px`
      inner["margin-right"] = `${bounds.right}px`
      inner["flex-grow"] = 1
    } else if (cHorizontal === "MAX") {
      outer["justify-content"] = "flex-end"
      inner["margin-right"] = `${bounds.right}px`
      inner["width"] = `${bounds.width}px`
      inner["min-width"] = `${bounds.width}px`
    } else if (cHorizontal === "CENTER") {
      outer["justify-content"] = "center"
      inner["width"] = `${bounds.width}px`
      if (bounds.left && bounds.right) inner["margin-left"] = `${bounds.left - bounds.right}px`
    } else if (cHorizontal === "SCALE") {
      const parentWidth = bounds.left + bounds.width + bounds.right
      inner["width"] = `${bounds.width * 100 / parentWidth}%`
      inner["margin-left"] = `${bounds.left * 100 / parentWidth}%`
    } else {
      inner["margin-left"] = `${bounds.left}px`
      inner["width"] = `${bounds.width}px`
      inner["min-width"] = `${bounds.width}px`
    }
  }

  if (outerClass !== "autolayoutVchild") {
    if (vHorizontal === "STRETCH") {
      inner["margin-top"] = `${bounds.top}px`
      inner["margin-bottom"] = `${bounds.bottom}px`
      inner["flex-grow"] = 1
    } else if (vHorizontal === "MAX") {
      outer["align-items"] = "flex-end"
      inner["margin-bottom"] = `${bounds.bottom}px`
      inner["height"] = `${bounds.height}px`
      inner["min-height"] = `${bounds.height}px`
    } else if (vHorizontal === "CENTER") {
      outer["align-items"] = "center"
      inner["height"] = `${bounds.height}px`
      inner["margin-top"] = `${bounds.top - bounds.bottom}px`
    } else if (vHorizontal === "SCALE") {
      const parentWidth = bounds.top + bounds.height + bounds.bottom
      inner["height"] = `${bounds.height * 100 / parentWidth}%`
      inner["margin-top"] = `${bounds.top * 100 / parentWidth}%`
    } else {
      inner["margin-top"] = `${bounds.top}px`
      inner["height"] = `${bounds.height}px`
      inner["min-height"] = `${bounds.height}px`
    }
  }

  if (node.type === "TEXT") {
    inner["display"] = "flex"
    if (node.textAlignVertical === "CENTER") {
      inner["align-items"] = "center"
    } else if (node.textAlignVertical === "BOTTOM") {
      inner["align-items"] = "flex-end"
    }

    if (node.textAlignHorizontal === "CENTER") {
      inner["justify-content"] = "center"
    } else if (node.textAlignHorizontal === "RIGHT") {
      inner["justify-content"] = "flex-end"
    }
  }

  return { inner, outer, outerClass }
}

function getOpacityStyle(node: BlendMixin): CSS {
  if (node.opacity === 1) return {}
  return {
    opacity: `${node.opacity}`
  }
}

function getEffectsStyle(node: BlendMixin): CSS {
  const style: CSS = {}

  for (const effect of node.effects) {
    if (!effect.visible) continue
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      style["box-shadow"] = `${effect.type === "INNER_SHADOW" ? "inset " : ""}${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${colorToCSS(effect.color, effect.color.a)}`
    } else if (effect.type === "BACKGROUND_BLUR") {
      style["backdrop-filter"] = `blur(${effect.radius}px)`
    }
  }

  return style
}

function getRoundedRectangleStyle(node: RectangleCornerMixin): CSS {
  return {"border-radius": `${node.topLeftRadius}px ${node.topRightRadius}px ${node.bottomRightRadius}px ${node.bottomLeftRadius}px`}
}

async function getStrokeStyleForPaints(width: number, paints: ReadonlyArray<Paint>): Promise<CSS> {
  for (let paint of paints) {
    if (!paint.visible) continue

    switch (paint.type) {
      case "SOLID": {
        return { border: `${width}px solid ${colorToCSS(paint.color, paint.opacity || 1.0)}` }
      }

      case "IMAGE": {
        const hash = paint.imageHash
        if (hash != null) {
          const img = figma.getImageByHash(hash)
          const bytes = await img.getBytesAsync()

          // TODO(jlfwong): Support images other than .pngs
          const path = `/images/${hash}.png`
          images[hash] = { bytes, path }
          return { "border-image": `url(${path}) ${width} round`}
        }
      }

      case "GRADIENT_LINEAR":
      case "GRADIENT_RADIAL":
      case "GRADIENT_DIAMOND":
      case "GRADIENT_ANGULAR": {
        // TODO(jlfwong): Handle gradients
        return {}
      }
    }
  }

  return {}
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
