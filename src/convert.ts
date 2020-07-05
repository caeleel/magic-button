export interface ImageToUpload {
  path: string
  bytes: Uint8Array
}

export interface FontInUse {
  name: string
}

export interface ConversionResult {
  pathToHtml: { [path: string]: string }
  hasMobileVersion: { [path: string]: boolean }
  images: { [hash: string]: ImageToUpload }
  fonts: { [name: string]: boolean }
  startFrameId: string
  frameIdToPath: { [id: string]: string }
  actions: Action[]
  name: string
  favicon: Uint8Array | null
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
let frameIdToSize: { [id: string]: string } = {}
let hasMobileVersion: ConversionResult["hasMobileVersion"]
let actions: ConversionResult["actions"]

function nameToPath(name: string): string {
  name = name.toLowerCase()
  return "/" + (name.endsWith(".html") ? name : name.replace(/\W+/g, "-") + "/index.html")
}

export async function convert(node: PageNode): Promise<ConversionResult> {
  images = {}
  fonts = {}
  frameIdToPath = {}
  frameIdToSize = {}
  hasMobileVersion = {}
  const pathToFrameId: { [path: string]: string } = {}
  actions = []

  // Build the routing table
  for (let pageChild of node.children) {
    switch (pageChild.type) {
      case "INSTANCE":
      case "COMPONENT":
      case "FRAME": {
        const path = nameToPath(pageChild.name)

        if (pathToFrameId[path]) {
          const otherFrame = pathToFrameId[path]
          if (frameIdToSize[otherFrame] === "mobile") {
            // this path already has a mobile version, skip it
            continue
          }

          hasMobileVersion[path] = true

          if (pageChild.width < (figma.getNodeById(otherFrame) as LayoutMixin).width) {
            frameIdToSize[pageChild.id] = "mobile"
            frameIdToPath[pageChild.id] = path
            continue
          } else {
            frameIdToSize[otherFrame] = "mobile"
          }
        }

        frameIdToSize[pageChild.id] = "desktop"
        frameIdToPath[pageChild.id] = path
        pathToFrameId[path] = pageChild.id
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

  const result = await convertPage(node)
  return {name: figma.currentPage.name, ...result, hasMobileVersion, images, fonts, frameIdToPath, startFrameId: startFrame.id, actions}
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

function isVectorSubtree(node: ChildrenMixin): boolean {
  for (const child of node.children) {
    if (child.type !== "SLICE" && child.reactions.length > 0) {
      return false
    }
    if (child.type === "GROUP" || child.type === "FRAME" || child.type === "INSTANCE" || child.type === "COMPONENT") {
      if(!isVectorSubtree(child)) return false
    } else if (child.type !== "VECTOR" && child.type !== "LINE" && 
               child.type !== "STAR" && child.type !== "ELLIPSE" && child.type !== "BOOLEAN_OPERATION" &&
               child.type !== "POLYGON" && child.type !== "SLICE") {
      return false
    }
  }
  return true
}

async function convertChildren(children: ReadonlyArray<BaseNode>): Promise<string> {
  const allChildren: Promise<string>[] = []
  function appendChildren(children: ReadonlyArray<BaseNode>) {
    for (const child of children) {
      if (child.type !== "GROUP") allChildren.push(convertNode(child))
      else if (child.visible) {
        if (isVectorSubtree(child)) {
          allChildren.push(convertShape(child as BaseNode & DefaultShapeMixin))
        } else if (child.parent && 'layoutMode' in child.parent && child.parent.layoutMode !== "NONE") {
          allChildren.push(convertNode(child))
        } else {
          appendChildren(child.children)
        }
      }
    }
  }
  appendChildren(children)

  return (await Promise.all(allChildren)).join("\n")
}

async function convertPage(node: PageNode): Promise<Pick<ConversionResult, 'favicon' | 'pathToHtml'>> {
  const retval: Pick<ConversionResult, 'favicon' | 'pathToHtml'> = { favicon: null, pathToHtml: {} }
  const data = retval.pathToHtml

  for (let child of node.children) {
    const path = frameIdToPath[child.id]
    if (!path) continue

    if (child.type === "INSTANCE" || child.type === "COMPONENT" || child.type === "FRAME") {
      if (child.name === "favicon.ico") {
        retval.favicon = await child.exportAsync({ format: 'PNG' })
      } else {
        const result = await convertTopLevelFrame(child)
        if (data[path]) {
          data[path] += result
        } else {
          data[path] = result
        }
      }
    }
  }
  return retval
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
    ...await getBackgroundStyleForPaints(node, 'fills' in node ? defaultForMixed(node.fills, []) : []),
  }

  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"

  return `<div class="${frameIdToSize[node.id]}" ${events} style="width: 100%; height: 100%; ${toStyleString(style)}">${await convertChildren(node.children)}</div>`
}

async function convertFrame(node: FrameNode | ComponentNode | InstanceNode): Promise<string> {
  if (isVectorSubtree(node)) return await convertShape(node)

  const style: CSS = {
    ...getOpacityStyle(node),
    ...getEffectsStyle(node),
    ...getRoundedRectangleStyle(node),
    ...await getStrokeStyleForPaints(node.strokeWeight, defaultForMixed(node.strokes, [])),
    ...await getBackgroundStyleForPaints(node, 'fills' in node ? defaultForMixed(node.fills, []) : []),
  }
  const layout = getLayoutStyle(node)

  await new Promise(resolve => setTimeout(resolve, 1));

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
  if (node.rotation !== 0) {
    return await convertShape(node)
  }

  const style: CSS = {
    ...getOpacityStyle(node),
    ...getEffectsStyle(node),
    ...getRoundedRectangleStyle(node),
    ...await getStrokeStyleForPaints(node.strokeWeight, defaultForMixed(node.strokes, [])),
    ...await getBackgroundStyleForPaints(node, defaultForMixed(node.fills, [])),
  }
  const layout = getLayoutStyle(node)
  const usePlaceholder = node.constraints.horizontal !== "STRETCH"
  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"
  return h("div", node.name, style, layout, events, usePlaceholder ? `<div style="width: ${node.width}; height: ${node.height}px"></div>` : "")
}

async function convertShape(node: BaseNode & DefaultShapeMixin): Promise<string> {
  // We don't include opacity here because it gets baked into the node

  const events = node.reactions ? eventHandlingAttributes(node.reactions) : ''
  const layout = getLayoutStyle(node)
  let style: CSS = getOpacityStyle(node)
  if (events.length > 0) style["cursor"] = "pointer"

  let hasImage = false

  if (node.fills) {
    for (const fill of node.fills as Paint[]) {
      if (fill.type === "IMAGE") {
        hasImage = true
        break
      }
    }
  }

  if (!hasImage) {
    try {
      const svg = await node.exportAsync({ format: 'SVG' })
      return h("div", node.name, style, layout, events, arrayBufferToString(svg))
    } catch (e) {
      console.error("Failed to convert shape to SVG, trying PNG", node, e)
    }
  }

  try {
    const png = await node.exportAsync({ format: 'PNG' })
    const hash = `_${Math.random()}`
    const path = `/images/${hash}`
    images[hash] = { bytes: png, path }
    style["background-image"] = `url(${path})`
    return h("div", node.name, style, layout, events, `<div style="width: ${node.width}; height: ${node.height}px"></div>`)
  } catch (e) {
    console.error("Failed to convert shape to PNG", node, e)
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

function convertTextRange(node: TextNode, start: number, end: number): string {
  const style: CSS = {}

  const color = colorFromPaints(defaultForMixed(node.getRangeFills(start, end), []))
  if (color != null) {
    style['color'] = color
  }

  const fontName = defaultForMixed(node.getRangeFontName(start, end), null)
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

  const decoration = defaultForMixed(node.getRangeTextDecoration(start, end), null)
  if (decoration === "UNDERLINE") {
    style['text-decoration'] = 'underline'
  } else if (decoration === "STRIKETHROUGH") {
    style['text-decoration'] = 'line-through'
  }

  const fontSize = defaultForMixed(node.getRangeFontSize(start, end), null)
  if (fontSize != null) {
    style['font-size'] = `${fontSize}px`
  }

  const textCase = defaultForMixed(node.getRangeTextCase(start, end), null)
  if (textCase === "LOWER") {
    style['text-transform'] = 'lowercase'
  } else if (textCase === "UPPER") {
    style['text-transform'] = 'uppercase'
  } else if (textCase === "TITLE") {
    style['text-transform'] = 'capitalize'
  }

  const lineHeight = defaultForMixed(node.getRangeLineHeight(start, end), null)
  if (lineHeight && lineHeight.unit === "PERCENT") {
    style['line-height'] = `${lineHeight.value}%`
  } else if (lineHeight && lineHeight.unit === "PIXELS") {
    style['line-height'] = `${lineHeight.value}px`
  }

  return `<span style='${toStyleString(style)}'>${node.characters.substring(start, end).replace("\n", "<br><br>")}</span>`
}

function convertText(node: TextNode): string {
  const style = {
    ...getOpacityStyle(node),
    ...getEffectsStyle(node),
  }

  style['text-align'] = node.textAlignHorizontal.toLowerCase()

  const events = eventHandlingAttributes(node.reactions)
  if (events.length > 0) style["cursor"] = "pointer"

  let content = ""
  const numChars = node.characters.length
  if (node.fills !== figma.mixed && node.fontSize !== figma.mixed && node.letterSpacing !== figma.mixed && 
      node.lineHeight !== figma.mixed && node.textCase !== figma.mixed && node.textDecoration !== figma.mixed &&
      node.fontName !== figma.mixed) {
    content = convertTextRange(node, 0, numChars)
  } else {
    let start = 0
    let end = 1
    while (end < numChars) {
      const check = end + 1
      if (node.getRangeFills(start, check) === figma.mixed || node.getRangeFontSize(start, check) === figma.mixed ||
          node.getRangeLetterSpacing(start, check) === figma.mixed || node.getRangeLineHeight(start, check) === figma.mixed ||
          node.getRangeTextCase(start, check) === figma.mixed || node.getRangeTextDecoration(start, check) === figma.mixed ||
          node.getRangeFontName(start, check) === figma.mixed) {
        content += convertTextRange(node, start, end)
        start = end
      }
      end++
    }
    content += convertTextRange(node, start, end)
  }

  return h("div", node.name, style, getLayoutStyle(node), events, `<div>${content}</div>`)
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

function getBoundingBox(node: LayoutMixin): Rect {
  const matrix = node.absoluteTransform
  const m00 = matrix[0][0]
  const m01 = matrix[0][1]
  const m02 = matrix[0][2]
  const m10 = matrix[1][0]
  const m11 = matrix[1][1]
  const m12 = matrix[1][2]
  const { width, height } = node

  const p1 = [m02, m12]
  const p2 = [m01 * height + m02, m11 * height + m12]
  const p3 = [m00 * width + m02, m10 * width + m12]
  const p4 = [m00 * width + m01 * height + m02, m10 * width + m11 * height + m12]

  const x = Math.min(p1[0], p2[0], p3[0], p4[0])
  const y = Math.min(p1[1], p2[1], p3[1], p4[1])
  const xMax = Math.max(p1[0], p2[0], p3[0], p4[0])
  const yMax = Math.max(p1[1], p2[1], p3[1], p4[1])

  return { x, y, width: xMax - x, height: yMax - y }
}

function getLayoutStyle(node: BaseNode & LayoutMixin): Layout {
  const { x, y, width, height } = getBoundingBox(node)

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

  const parentBounds = getBoundingBox(parent)
  let px = parentBounds.x
  let py = parentBounds.y

  const bounds = {
    left: x - px,
    right: px + parentBounds.width - (x + width),
    top: y - py,
    bottom: py + parentBounds.height - (y + height),
    width: width,
    height: height,
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
    inner["padding"] = `${node.verticalPadding}px ${node.horizontalPadding}px`
    if (node.layoutMode === "VERTICAL") {
      inner["flex-direction"] = "column"
      if (node.constraints.vertical === "STRETCH") {
        inner["justify-content"] = "space-between"
      }
    } else {
      if (node.constraints.horizontal === "STRETCH") {
        inner["justify-content"] = "space-between"
      }
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
      outer["height"] = "100%"
      inner["margin-top"] = `${bounds.top}px`
      inner["margin-bottom"] = `${bounds.bottom}px`
      inner["flex-grow"] = 1
    } else if (vHorizontal === "MAX") {
      outer["align-items"] = "flex-end"
      outer["height"] = "100%"
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

function getEffectsStyle(node: BaseNode & BlendMixin): CSS {
  const style: CSS = {}

  for (const effect of node.effects) {
    if (!effect.visible) continue
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      style[`${node.type === "TEXT" ? "text" : "box"}-shadow`] = `${effect.type === "INNER_SHADOW" ? "inset " : ""}${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${colorToCSS(effect.color, effect.color.a)}`
    } else if (effect.type === "BACKGROUND_BLUR") {
      style["backdrop-filter"] = `blur(${effect.radius}px)`
    }
  }

  return style
}

function getRoundedRectangleStyle(node: RectangleCornerMixin): CSS {
  return {"border-radius": `${node.topLeftRadius}px ${node.topRightRadius}px ${node.bottomRightRadius}px ${node.bottomLeftRadius}px`}
}

function paintToLinearGradient(paint: GradientPaint) {
  const transform = paint.gradientTransform
  let rotation = 0
  const a = transform[0][0]
  const b = transform[0][1]
  const c = transform[1][0]
  const d = transform[1][1]

  if (a != 0 || b != 0) {
    const r = Math.sqrt(a * a + b * b)
    rotation = (b > 0 ? Math.acos(a / r) : -Math.acos(a / r)) + Math.PI / 2
  } else if (c != 0 || d != 0) {
    const s = Math.sqrt(c * c + d * d);
    rotation = Math.PI - (d > 0 ? Math.acos(-c / s) : -Math.acos(c / s));
  }

  const stops = paint.gradientStops.map((stop) => {
    return `${colorToCSS(stop.color, stop.color.a)} ${Math.round(stop.position * 100)}%`
  }).join(', ')
  return `linear-gradient(${rotation}rad, ${stops})`
}

function paintToRadialGradient(paint: GradientPaint) {
  const stops = paint.gradientStops.map((stop) => {
    return `${colorToCSS(stop.color, stop.color.a)} ${Math.round(stop.position * 60)}%`
  }).join(', ');

  return `radial-gradient(${stops})`
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
          return { "border-width": `${width}px`, "border-style": "solid", "border-image": `url(${path}) 30%`}
        }
      }

      case "GRADIENT_LINEAR":
        return { "border-width": `${width}px`, "border-style": "solid", "border-image": `${paintToLinearGradient(paint as GradientPaint)} 30%` }
      case "GRADIENT_RADIAL":
        return { "border-width": `${width}px`, "border-style": "solid", "border-image": `${paintToRadialGradient(paint)} 30%` }
      case "GRADIENT_DIAMOND":
      case "GRADIENT_ANGULAR": {
        // TODO(jlfwong): Handle gradients
        return {}
      }
    }
  }

  return {}
}

async function getBackgroundStyleForPaints(node: SceneNode, paints: ReadonlyArray<Paint>): Promise<CSS> {
  for (let paint of paints) {
    if (!paint.visible) continue

    switch (paint.type) {
      case "SOLID": {
        return { "background-color": colorToCSS(paint.color, paint.opacity || 1.0) }
      }

      case "IMAGE": {
        const hash = paint.imageHash
        if (hash != null) {
          const img = figma.getImageByHash(hash)
          const bytes = await img.getBytesAsync()
          const dv = new DataView(bytes.buffer, 0, 28)

          // TODO(jlfwong): Support images other than .pngs
          const path = `/images/${hash}.png`
          images[hash] = { bytes, path }
          if (paint.scaleMode === "FIT") {
            return { "background": `url(${path}) no-repeat center center/contain` }
          } else if (paint.scaleMode === "FILL") {
            return { "background": `url(${path}) no-repeat center center/cover` }
          } else if (paint.scaleMode === "TILE") {
            const width = dv.getInt32(16) * paint.scalingFactor!
            const height = dv.getInt32(20) * paint.scalingFactor!
            return {
              "background-image": `url(${path})`,
              "background-repeat": 'repeat',
              "background-size": `${width}px ${height}px`,
            }
          } else if (paint.scaleMode === "CROP") {
            const transform = paint.imageTransform!
            const fullWidth = node.width / transform[0][0]
            const fullHeight = node.height / transform[1][1]
            const xOff = fullWidth * transform[0][2]
            const yOff = fullHeight * transform[1][2]

            return {
              "background": `url(${path}) no-repeat ${-xOff}px ${-yOff}px/${fullWidth}px ${fullHeight}px`,
            }
          }
        }
      }

      case "GRADIENT_LINEAR":
        return { "background": paintToLinearGradient(paint as GradientPaint) }
      case "GRADIENT_RADIAL":
        return { "background": paintToRadialGradient(paint) }
      case "GRADIENT_DIAMOND":
      case "GRADIENT_ANGULAR": {
        // TODO(jlfwong): Handle gradients
      }
    }
  }

  return {}
}
