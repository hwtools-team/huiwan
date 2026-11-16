import React from "react";
import { createRoot } from "react-dom/client";
import Home from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("页面容器不存在");
createRoot(root).render(<React.StrictMode><Home /></React.StrictMode>);
