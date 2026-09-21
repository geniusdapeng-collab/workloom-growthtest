import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { OverlayManager } from "@workloom/ui";
import App from "./App";
import { BackendGate } from "./components/BackendGate";
import "./styles/tokens.css";
import "@workloom/ui/tokens.css";
import "@workloom/ui/content-safety.css";
import "@workloom/ui/components.css";
import { VoiceEngine } from "./voice/VoiceEngine";

// 2026-09-21 真机修复：应用启动即预热系统音色表，避免开场第一句抢在音色表就绪之前
// 落到操作系统默认声（macOS 中文默认常为男声，织伴会"先男后女"）。
VoiceEngine.warmUp();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayManager>
      <BrowserRouter>
        {/* 环境守门员：后端未就绪时渲染引导页而非错乱页面（首启体验保护） */}
        <BackendGate>
          <App />
        </BackendGate>
      </BrowserRouter>
    </OverlayManager>
  </StrictMode>,
);
