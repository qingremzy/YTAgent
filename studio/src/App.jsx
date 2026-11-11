import React, { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "@clipkit/editor";
import { ClipkitRuntime } from "@clipkit/runtime";
import "@clipkit/editor/styles.css";

const EDITOR_CONFIGURATION = {
  id: "ytagent-production",
  views: {
    timeline: true,
    mixer: true,
    layers: true,
    assets: false,
    json: false,
    keyframeLanes: true,
    curveEditor: true
  },
  dock: ["text", "shape", "caption"],
  knobs: "all"
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function App() {
  const projectId = new URLSearchParams(window.location.search).get("project") || "";
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState("Loading project");
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderError, setRenderError] = useState("");
  const [exported, setExported] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const saveTimer = useRef(null);
  const saveSequence = useRef(0);
  const saveAbort = useRef(null);
  const exportUrl = useRef("");

  useEffect(() => {
    if (!/^[a-f0-9]{24}$/i.test(projectId)) {
      setLoadError("This studio link is missing a valid project ID.");
      setSaveStatus("No project");
      return;
    }
    let active = true;
    fetch("/api/studio/projects/" + encodeURIComponent(projectId), { credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not open this studio project.");
        return data;
      })
      .then((data) => {
        if (!active) return;
        setProject(data);
        setSaveStatus("All changes saved");
      })
      .catch((error) => {
        if (active) {
          setLoadError(error.message || "Could not load the studio project.");
          setSaveStatus("Unavailable");
        }
      });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (saveAbort.current) saveAbort.current.abort();
    if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
  }, []);

  const persistSource = useCallback(async (source) => {
    const sequence = ++saveSequence.current;
    if (saveAbort.current) saveAbort.current.abort();
    const controller = new AbortController();
    saveAbort.current = controller;
    setSaveStatus("Saving changes…");
    try {
      const response = await fetch("/api/studio/projects/" + encodeURIComponent(projectId), {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save the project.");
      if (sequence === saveSequence.current) setSaveStatus("All changes saved");
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      if (sequence === saveSequence.current) setSaveStatus("Save failed");
      throw error;
    }
  }, [projectId]);

  const handleSourceChange = useCallback((source) => {
    setProject((current) => current ? { ...current, source } : current);
    setSaveStatus("Unsaved changes");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      persistSource(source).catch((error) => setRenderError(error.message || "Autosave failed."));
    }, 900);
  }, [persistSource]);

  const handleRender = useCallback(async (source, request) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setRenderError("");
    setPublishError("");
    setPublishedUrl("");
    setExported(null);
    setRendering(true);
    setRenderProgress(0);
    let runtime;
    try {
      await persistSource(source);
      const canvas = document.createElement("canvas");
      canvas.width = source.width || 540;
      canvas.height = source.height || 960;
      runtime = new ClipkitRuntime(canvas);
      const ready = await runtime.init({ backend: "auto" });
      if (!ready) throw new Error("This browser could not start a supported graphics engine. Update Chrome and try again.");
      runtime.load(source);
      await runtime.preload();
      const blob = await runtime.export({
        renderResolution: request.resolution || "source",
        onProgress: (progress) => setRenderProgress(Math.max(0, Math.min(100, Math.round(progress * 100))))
      });
      if (!(blob instanceof Blob) || blob.size < 10000) throw new Error("The editor did not produce a valid MP4.");
      const url = URL.createObjectURL(blob);
      exportUrl.current = url;
      setExported({ blob, url, filename: "YTAgent-" + projectId + ".mp4" });
      setRenderProgress(100);
    } catch (error) {
      setRenderError(error.message || "Export failed. Try source resolution or a shorter edit.");
    } finally {
      if (runtime) runtime.dispose();
      setRendering(false);
    }
  }, [persistSource, projectId]);

  const handlePublish = async () => {
    if (!exported?.blob || !project) return;
    setPublishing(true);
    setPublishError("");
    setPublishedUrl("");
    try {
      const form = new FormData();
      form.append("video", new File([exported.blob], exported.filename, { type: "video/mp4" }));
      const metadata = project.metadata || {};
      form.append("title", String(metadata.title || project.title || "YTAgent video").slice(0, 100));
      form.append("description", String(metadata.description || ""));
      form.append("tags", Array.isArray(metadata.tags) ? metadata.tags.join(", ") : "");
      form.append("keywords", Array.isArray(metadata.keywords) ? metadata.keywords.join(", ") : "");
      form.append("hashtags", Array.isArray(metadata.hashtags) ? metadata.hashtags.join(" ") : "");
      form.append("privacy", "public");
      const response = await fetch("/api/upload", { method: "POST", credentials: "same-origin", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "YouTube publishing failed.");
      setPublishedUrl(data.url || "");
    } catch (error) {
      setPublishError(error.message || "YouTube publishing failed.");
    } finally {
      setPublishing(false);
    }
  };

  if (loadError) {
    return <main className="studio-state"><h1>YTAgent Studio</h1><p>{loadError}</p><a href="/">Return to YTAgent</a></main>;
  }
  if (!project) {
    return <main className="studio-state"><div className="loader" /><h1>Opening your production…</h1><p>Loading the original scenes and narration.</p></main>;
  }

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <a className="back-link" href="/">← YTAgent</a>
        <div className="project-heading">
          <span className="eyebrow">PRODUCTION EDITOR</span>
          <strong>{project.title || "Untitled production"}</strong>
        </div>
        <span className={"save-indicator " + (saveStatus === "All changes saved" ? "saved" : "")}>{saveStatus}</span>
      </header>

      <section className="editor-frame" aria-label="Video timeline editor">
        <Editor
          initialSource={project.source}
          configuration={EDITOR_CONFIGURATION}
          theme="dark"
          onSourceChange={handleSourceChange}
          onRender={handleRender}
          rendering={rendering}
          renderProgress={renderProgress}
          backend="auto"
          exportFormats={[{ id: "mp4", label: "MP4 video" }]}
        />
      </section>

      {(rendering || exported || renderError || publishedUrl || publishError) && (
        <section className="export-status" aria-live="polite">
          {rendering && <div className="progress-row"><span>Rendering MP4</span><strong>{renderProgress}%</strong><div className="progress-track"><i style={{ width: renderProgress + "%" }} /></div></div>}
          {renderError && <p className="error-text">{renderError}</p>}
          {exported && !rendering && (
            <div className="export-actions">
              <a className="action-button secondary" href={exported.url} download={exported.filename}>Download MP4</a>
              <button className="action-button primary" onClick={handlePublish} disabled={publishing}>{publishing ? "Publishing…" : "Publish to YouTube"}</button>
            </div>
          )}
          {publishError && <p className="error-text">{publishError}</p>}
          {publishedUrl && <p className="success-text">Published successfully. <a href={publishedUrl} target="_blank" rel="noreferrer">Watch on YouTube ↗</a></p>}
        </section>
      )}
    </main>
  );
}
