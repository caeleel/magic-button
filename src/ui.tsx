import * as React from 'react'
import * as ReactDOM from 'react-dom'
import './ui.css'
import sha1 from 'sha1'
import { useRef, useState, useEffect } from 'react'

const randomKey = Math.random(); // replace with stronger key later

function netlifyRequest(method: string, url: string, token: string, body: any, contentType: string) {
  if (contentType === "application/json") {
    body = JSON.stringify(body)
  }

  return fetch(url, {
    body,
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": contentType,
    },
  })
}

function App() {
  const [content, setContent] = useState("")
  const [token, setToken] = useState("")
  const [siteId, setSiteId] = useState("")
  const [deployed, setDeployed] = useState(false)
  const [url, setUrl] = useState("")

  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      const msg = ev.data.pluginMessage
      if (msg.type === "init") {
        setToken(msg.token)
        setSiteId(msg.siteId)
        setUrl(msg.url)

        if (msg.token !== "" && msg.siteId === "") {
          createSiteIfNotExists(msg.token)
        } else if (msg.token !== "" && msg.siteId !== "") {

        }
        return
      }

      console.log("DATA", ev.data)
      setContent(msg)
    }
    window.addEventListener("message", handleMessage)
    return () => {
      window.removeEventListener("message", handleMessage)
    }
  })

  const deploySite = async () => {
    const body = `<html><body>${content}</body></html>`
    const sha = sha1(body)
    let resp = await netlifyRequest('POST', `https://api.netlify.com/api/v1/sites/${siteId}/deploys`, token, {
      files: { "/index.html": sha }
    }, "application/json")

    if (resp.status !== 200) {
      console.error(`Could not create deploy: ${resp.status}`)
      return
    }

    const result = await resp.json()
    resp = await netlifyRequest('PUT', `https://api.netlify.com/api/v1/deploys/${result.id}/files/index.html`, token, body, "application/octet-stream")

    if (resp.status !== 200) {
      console.error(`Could not upload index.html: ${resp.status}`)
      return
    }

    setDeployed(true)
  }

  const createSiteIfNotExists = async (tok: string) => {
    if (siteId !== "") return
    if (tok === "") return

    const resp = await netlifyRequest('POST', `https://api.netlify.com/api/v1/sites`, tok, "", "text/html")

    if (resp.status === 201) {
      const result = await resp.json()
      setSiteId(result.site_id)
      parent.postMessage({ pluginMessage: { type: "netlify-site", site_id: result.site_id, url: result.url } }, '*');
    }
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
      if (siteId === "") createSiteIfNotExists(result.token)
      parent.postMessage({ pluginMessage: { type: "token-response", token: result.token } }, '*')
    } catch (e) {
      setTimeout(pollForToken, 2000)
    }
  }

  const tryConnect = () => {
    window.open(`https://oauth-helper.netlify.app/?key=${randomKey}`)
    setTimeout(pollForToken, 2000)
  }

  return <div>
    <div style={{position: 'absolute', zIndex: 1000}}>
      {token === "" && <button onClick={tryConnect}>Connect</button>}
      {token !== "" && siteId !== "" && !deployed && <button onClick={() => deploySite()}>Magic</button>}
      {deployed && <a href={url} onClick={() => window.open(url)}>Visit site</a>}
    </div>
    <div dangerouslySetInnerHTML={{ __html: content }} />
  </div>
}

ReactDOM.render(<App />, document.getElementById('react-page'))
