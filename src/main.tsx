import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 注意：不使用 React.StrictMode。
// 原因：tauri-plugin-libmpv 创建的 mpv 实例是按窗口 label 全局唯一的 OS 资源，
// StrictMode 在 dev 下故意双重挂载 effect 会导致 destroy() 在二次挂载前被调用，
// 留下空壳状态。详见 useMpv.ts 顶部注释。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
