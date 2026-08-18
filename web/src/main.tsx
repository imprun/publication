import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AuthProvider } from "./auth/auth-context";
import { CloudApplication } from "./cloud-app";
import { readPublicConfig } from "./config";
import { createFixtureClient } from "./fixture-client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Publication root element is missing");

const config = readPublicConfig();

createRoot(root).render(
  <StrictMode>
    {config.mode === "fixture" ? (
      <App client={createFixtureClient()} fixtureMode />
    ) : config.mode === "cloud" ? (
      <AuthProvider config={config}>
        <CloudApplication config={config} />
      </AuthProvider>
    ) : (
      <main className="configuration-page">
        <div className="configuration-card" role="alert">
          <span className="brand-mark">P</span>
          <h1>Publication을 연결할 수 없습니다.</h1>
          <p>{config.message}</p>
        </div>
      </main>
    )}
  </StrictMode>,
);
