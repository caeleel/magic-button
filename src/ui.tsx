import * as React from 'react'
import * as ReactDOM from 'react-dom'
import './ui.css'
import { useRef, useState, useEffect } from 'react'

function App() {
  const [content, setContent] = useState("")

  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      console.log("DATA", ev.data)
      setContent(ev.data.pluginMessage)
    }
    window.addEventListener("message", handleMessage)
    return () => {
      window.removeEventListener("message", handleMessage)
    }
  })

  return <div dangerouslySetInnerHTML={{__html: content}} />
}

ReactDOM.render(<App />, document.getElementById('react-page'))
