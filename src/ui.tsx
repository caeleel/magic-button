import * as React from 'react'
import * as ReactDOM from 'react-dom'
import './ui.css'
import { useRef, useState, useEffect } from 'react'

const randomKey = Math.random(); // replace with stronger key later

function App() {
  const [content, setContent] = useState("")
  const [token, setToken] = useState("")
  const [siteId, setSiteId] = useState("")
  const [url, setUrl] = useState("")

  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      const msg = ev.data.pluginMessage
      if (msg.type === "token") {
        setToken(msg.token)
        return
      }
      if (msg.type === "site-id") {
        setSiteId(msg.siteId)
        setUrl(msg.url)
        return
      }
      if (msg.type === "site-request") {
        createSiteIfNotExists(msg.token)
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

  const createSiteIfNotExists = async (tok: string) => {
    if (siteId) return
    if (tok === "") return

    const resp = await fetch(`https://api.netlify.com/api/v1/sites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`},
    })

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
    <div dangerouslySetInnerHTML={{ __html: content }} />
    {token === "" && <button onClick={tryConnect}>Connect</button>}
  </div>
}

ReactDOM.render(<App />, document.getElementById('react-page'))
