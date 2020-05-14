import * as React from 'react'
import * as ReactDOM from 'react-dom'
import './ui.css'
import sha1 from 'sha1'
import { useRef, useState, useEffect } from 'react'
import { ConversionResult } from './convert'

const randomKey = Math.random(); // replace with stronger key later

function netlifyRequest(method: string, url: string, token: string, body: any, contentType: string) {
  if (contentType === "application/json") {
    body = JSON.stringify(body)
  }

  const opts: any = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": contentType,
    },
  }

  if (method !== "GET") opts.body = body

  return fetch(url, opts)
}

interface Site {
  url: string
  id: string
}

interface PackagedWebsite {
  // Map from path to hash
  files: {[path: string]: string}

  // Map from hash to content
  blobs: {[hash: string]: string | Uint8Array}
}

// This function must not depend on anything else in this file! This is serialized to a string
// and injected into the running page.
const injectRuntime = (frameIdToPath: ConversionResult["frameIdToPath"], actions: ConversionResult["actions"]) => {
  console.log("Booting magic button website", frameIdToPath, actions)

  ;(window as any)["magic_runAction"] = function(actionId: number) {
    const action = actions[actionId]
    switch(action.type) {
      case "NODE": {
        if (action.navigation === "NAVIGATE") {
          if (action.destinationId !== null) {
            let path = frameIdToPath[action.destinationId]
            if (path != null) {
              if (path.endsWith("index.html")) {
                path = path.slice(0, path.indexOf("index.html"))
              }
              window.location.href = path
            }
          }
        }
        break
      }

      case "URL": {
        window.location.href = action.url
        break
      }
    }
  }
}

function serializeRuntime(result: ConversionResult): string {
  return `<script>(${injectRuntime.toString()})(${JSON.stringify(result.frameIdToPath)}, ${JSON.stringify(result.actions)})</script>`
}

function compileForNetlify(data: ConversionResult): PackagedWebsite {
  const site: PackagedWebsite = {
    files: {},
    blobs: {}
  }

  let fontLoadingHTML = (Object.keys(data.fonts).map(fontName => {
    return `<link href="https://fonts.googleapis.com/css2?family=${fontName}&display=swap" rel="stylesheet">`
  })).join("")

  for (let path in data.pathToHtml) {
    const content = `<html><head>
    <title>${path}</title>
    <style>
    body {
      padding: 0;
      margin: 0;
      width: 100%;
      overflow-x: hidden;
    }
    .outerDiv {
      position: absolute;
      top: 0;
      display: flex;
      width: 100%;
      pointer-events: none;
    }
    ${data.hasMobileVersion[path] ? `
    .desktop {
      display: none;
    }

    .mobile {
      overflow-x: hidden;
    }

    @media only screen and (min-width: 1024px) {
      .desktop {
        display: block;
      }

      .mobile {
        display: none;
      }
    }
    ` : ''}
    .autolayoutVchild {
      width: 100%;
      display: flex;
      pointer-events: none;
    }
    .autolayoutHchild {
      height: 100%;
      display: flex;
      pointer-events: none;
    }
    .innerDiv {
      position: relative;
      box-sizing: border-box;
      pointer-events: auto;
    }
    </style>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    ${fontLoadingHTML}
    ${serializeRuntime(data)}
    <body>${data.pathToHtml[path]}</body>
    </html>`

    const hash = sha1(content)
    site.files[path] = hash
    site.blobs[hash] = content
  }

  for (let imageHash in data.images) {
    const img = data.images[imageHash]
    if (imageHash[0] === '_') {
      // this is not a real hash, recompute the sha1
      imageHash = sha1(Buffer.from(img.bytes))
    }
    site.files[img.path] = imageHash
    site.blobs[imageHash] = img.bytes
  }

  console.log(site)

  return site
}

function App() {
  const [token, setToken] = useState("")
  const [siteId, setSiteId] = useState("")
  const [deployed, setDeployed] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sites, setSites] = useState<Site[]>([])

  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      const msg = ev.data.pluginMessage
      if (msg.type === "init") {
        setToken(msg.token)
        setSiteId(msg.siteId)

        if (msg.token !== "") {
          getAvailableSites(msg.token)
        }
        return
      } else if (msg.type == "conversion-result") {
        console.log("conversion-result", msg.content)
        deploySite(msg.content)
      }
    }
    window.addEventListener("message", handleMessage)
    return () => {
      window.removeEventListener("message", handleMessage)
    }
  })

  const deploySite = async (conversionResult: ConversionResult) => {
    if (conversionResult === null) return

    let site = siteId
    if (site === "new" || site === "") {
      site = await createNewSite(token)
      if (site === "") return
    }

    const compiled = compileForNetlify(conversionResult)

    let resp = await netlifyRequest('POST', `https://api.netlify.com/api/v1/sites/${site}/deploys`, token, {
      files: compiled.files
    }, "application/json")

    if (resp.status === 404) {
      site = await createNewSite(token)
      if (site === "") return
      resp = await netlifyRequest('POST', `https://api.netlify.com/api/v1/sites/${site}/deploys`, token, {
        files: compiled.files
      }, "application/json")
    }

    if (resp.status !== 200) {
      console.error(`Could not create deploy: ${resp.status}`)
      return
    }

    const result = await resp.json()
    const deployId = result.id

    const uploads = Object.keys(compiled.files).map(async (path) => {
      const hash = compiled.files[path]
      const blob = compiled.blobs[hash]

      const url = `https://api.netlify.com/api/v1/deploys/${deployId}/files/${path}`
      try {
        console.log(`Uploading ${path}...`)
        await netlifyRequest('PUT', url, token, blob, "application/octet-stream")
        console.log(`Successfully uploaded ${path}...`)
      } catch(e) {
        console.log(`Failed to upload ${path}...`)
        throw e
      }
    })

    await Promise.all(uploads)

    if (resp.status !== 200) {
      console.error(`Could not upload index.html: ${resp.status}`)
      return
    }

    setDeploying(false)
    setDeployed(true)
  }

  const getAvailableSites = async (tok: string) => {
    const resp = await netlifyRequest('GET', 'https://api.netlify.com/api/v1/sites', tok, "", "text/html")
    if (resp.status === 401) {
      setToken("")
      parent.postMessage({ pluginMessage: { type: "token-response", token: "" } }, '*')
    }
    if (resp.status !== 200) {
      return
    }
    const result = await resp.json()
    setSites(result.map((x: any) => ({ id: x.site_id, url: x.url })))
    setLoaded(true)
  }

  const createNewSite = async (tok: string): Promise<string> => {
    if (tok === "") return ""

    const resp = await netlifyRequest('POST', `https://api.netlify.com/api/v1/sites`, tok, "", "text/html")

    if (resp.status === 201) {
      const result = await resp.json()
      setSiteId(result.site_id)
      setSites([...sites, {id: result.site_id, url: result.url}])
      parent.postMessage({ pluginMessage: { type: "netlify-site", site_id: result.site_id } }, '*')
      return result.site_id
    }

    return ""
  }

  const pollForToken = async () => {
    try {
      const resp = await fetch(`https://oauth-helper.netlify.app/.netlify/functions/fetch?key=${randomKey}`)
      if (resp.status === 400) {
        setTimeout(pollForToken, 2000)
        return
      }
      const result = await resp.json()
      setToken(result.token)
      if (siteId === "") createNewSite(result.token)
      parent.postMessage({ pluginMessage: { type: "token-response", token: result.token } }, '*')
      getAvailableSites(result.token)
    } catch (e) {
      setTimeout(pollForToken, 2000)
    }
  }

  const tryConnect = () => {
    window.open(`https://oauth-helper.netlify.app/?key=${randomKey}`)
    setTimeout(pollForToken, 2000)
  }

  const changeSite = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const site = e.currentTarget.value
    setSiteId(site)
    if (site !== "new") {
      parent.postMessage({ pluginMessage: { type: "netlify-site", site_id: site } }, '*');
    }
  }

  const deploy = () => {
    setDeploying(true)
    // delay slightly so we start showing progress bar
    setTimeout(() => parent.postMessage({ pluginMessage: { type: "run" } }, '*'), 100)
  }

  const sitesToChoose = [...sites, { id: "new", url: "Create new site" }]
  let selected = "new"
  let url = ""
  for (const site of sites) {
    if (site.id === siteId) {
      selected = siteId
      url = site.url
      break
    }
  }

  if (selected !== siteId) {
    setSiteId(selected)
  }

  return <div>
    <div>
      {token === "" && <>
        <div id="copy-connect">Connect your Netlify account to start deploying your Figma designs as live sites!</div>
        <button onClick={tryConnect}>Connect</button>
      </>}
      {loaded && !deploying && token !== "" && !deployed && <>
        <span id="copy-select-site">Where would you like to deploy your site?</span>
        <select id="site" value={selected} onChange={changeSite}>
          {sitesToChoose.map((site) => <option key={site.id} value={site.id}>{site.url}</option>)}
        </select>
      </>}
      {loaded && !deploying && token !== "" && !deployed && <button onClick={deploy}>Make Magic</button>}
      {deploying && <div className="progressWrap">
        <div className="progress" />
      </div>}
      {deployed && <>
        <div id="copy-success">Congrats, your site is now live!</div>
        {/* <a id="site" href={url} onClick={() => window.open(url)}>Visit site</a> */}
        <button onClick={() => window.open(url)}>Visit Site</button>
      </>}
    </div>
  </div>
}

ReactDOM.render(<App />, document.getElementById('react-page'))
