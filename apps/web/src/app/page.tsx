"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { DocumentDto, TemplateDto, TemplateId, WorkspaceDto } from "@trellis/shared";

import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import {
  ApiRequestError,
  createDocument,
  createDocumentFromTemplate,
  createWorkspace,
  getMe,
  listDocuments,
  listTemplates,
  listWorkspaces,
  login,
  register,
} from "@/lib/api";
import {
  clearSession,
  isSessionExpired,
  readSession,
  saveSession,
  type BrowserSession,
} from "@/lib/session";

type AuthMode = "login" | "register";

export default function DashboardPage() {
  const router = useRouter();
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templateQuery, setTemplateQuery] = useState("");
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [documentTitle, setDocumentTitle] = useState("Untitled canvas");

  useEffect(() => {
    const stored = readSession();
    const reason = new URLSearchParams(window.location.search).get("reason");
    if (reason === "expired") setAuthError("Your access token expired. Sign in again.");
    if (stored && !isSessionExpired(stored)) {
      setSession(stored);
      // A valid-looking token can outlive its user row after a local reset or
      // account deletion. Verify once so the dashboard never gets stuck on a
      // ghost session that cannot create workspaces.
      void getMe(stored.accessToken).catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 401) {
          clearSession();
          setSession(null);
          setAuthError("Your session is no longer valid. Sign in again.");
        }
      });
    } else {
      if (stored) clearSession();
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!session) {
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setTemplates([]);
      return;
    }
    let cancelled = false;
    setDataBusy(true);
    setDataError(null);

    listWorkspaces(session.accessToken)
      .then((result) => {
        if (cancelled) return;
        setWorkspaces(result);
        setSelectedWorkspaceId((current) => {
          if (current && result.some((workspace) => workspace.id === current)) return current;
          return result[0]?.id ?? null;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handleSessionError(error, setSession, setAuthError);
      })
      .finally(() => {
        if (!cancelled) setDataBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    listTemplates(session.accessToken)
      .then((result) => {
        if (!cancelled) setTemplates(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) handleSessionError(error, setSession, setDataError);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session || !selectedWorkspaceId) {
      setDocuments([]);
      return;
    }
    let cancelled = false;
    setDataError(null);

    listDocuments(session.accessToken, selectedWorkspaceId)
      .then((result) => {
        if (!cancelled) setDocuments(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) handleSessionError(error, setSession, setAuthError);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, session]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;

  const handleAuth = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const auth =
        authMode === "login"
          ? await login({ email, password })
          : await register({ email, password, displayName });
      const stored = saveSession(auth);
      setSession(stored);
      setPassword("");
      const next = safeNextPath();
      if (next) router.replace(next);
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = (): void => {
    clearSession();
    setSession(null);
    setWorkspaces([]);
    setDocuments([]);
    setSelectedWorkspaceId(null);
  };

  const handleCreateWorkspace = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!session || workspaceName.trim().length === 0) return;
    setDataBusy(true);
    setDataError(null);
    try {
      const workspace = await createWorkspace(session.accessToken, workspaceName.trim());
      setWorkspaces((current) => [...current, workspace]);
      setSelectedWorkspaceId(workspace.id);
      setWorkspaceName("");
    } catch (error) {
      handleSessionError(error, setSession, setDataError);
    } finally {
      setDataBusy(false);
    }
  };

  const handleCreateDocument = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!session || !selectedWorkspace || documentTitle.trim().length === 0) return;
    setDataBusy(true);
    setDataError(null);
    try {
      const created = await createDocument(
        session.accessToken,
        selectedWorkspace.id,
        documentTitle.trim(),
      );
      router.push(`/documents/${created.id}`);
    } catch (error) {
      handleSessionError(error, setSession, setDataError);
    } finally {
      setDataBusy(false);
    }
  };

  const handleCreateFromTemplate = async (templateId: TemplateId): Promise<void> => {
    if (!session || !selectedWorkspace || selectedWorkspace.role === "viewer") return;
    setDataBusy(true);
    setDataError(null);
    try {
      const created = await createDocumentFromTemplate(
        session.accessToken,
        selectedWorkspace.id,
        templateId,
      );
      router.push(`/documents/${created.id}`);
    } catch (error) {
      handleSessionError(error, setSession, setDataError);
    } finally {
      setDataBusy(false);
    }
  };

  if (booting) {
    return (
      <main className="centered-page">
        <span className="spinner" />
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <div className="auth-theme">
          <ThemeSwitcher />
        </div>
        <section className="auth-brand">
          <BrandMark />
          <div>
            <p className="eyebrow">Realtime document canvas</p>
            <h1>Build ideas together, on one infinite surface.</h1>
            <p className="lede">
              Trellis keeps every shape, text block, and layer convergent with Yjs,
              while presence stays local and instant. Offline edits come back with you.
            </p>
          </div>
          <ul className="feature-list">
            <li>CRDT convergence without server merge code</li>
            <li>Sticky notes, multi-select, layers, and offline-first editing</li>
            <li>Light, dark, and rust workspaces that remember your choice</li>
          </ul>
        </section>

        <section className="auth-card" aria-labelledby="auth-title">
          <div className="segmented" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "login"}
              className={authMode === "login" ? "selected" : ""}
              onClick={() => {
                setAuthMode("login");
                setAuthError(null);
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "register"}
              className={authMode === "register" ? "selected" : ""}
              onClick={() => {
                setAuthMode("register");
                setAuthError(null);
              }}
            >
              Create account
            </button>
          </div>
          <h2 id="auth-title">
            {authMode === "login" ? "Welcome back" : "Start a new workspace"}
          </h2>
          <form className="stack-form" onSubmit={(event) => void handleAuth(event)}>
            {authMode === "register" ? (
              <label>
                Display name
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
            ) : null}
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                minLength={authMode === "register" ? 12 : 1}
                maxLength={128}
                required
              />
            </label>
            {authMode === "register" ? (
              <p className="form-hint">Use at least 12 characters.</p>
            ) : null}
            {authError ? <p className="form-error">{authError}</p> : null}
            <button className="button-primary wide" type="submit" disabled={authBusy}>
              {authBusy ? "Working…" : authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
          <p className="auth-footnote">
            Access tokens are held in session storage and expire after one hour.
          </p>
        </section>
      </main>
    );
  }

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <a className="brand-lockup" href="/">
          <BrandMark small />
          <span>Trellis</span>
        </a>
        <div className="dashboard-user">
          <ThemeSwitcher />
          <span>
            <strong>{session.user.displayName}</strong>
            <small>{session.user.email}</small>
          </span>
          <button type="button" className="button-ghost" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {authError ? <div className="global-error">{authError}</div> : null}
      {dataError ? <div className="global-error">{dataError}</div> : null}

      <main className="dashboard-main">
        <section className="workspace-column">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>Your spaces</h2>
            </div>
            {dataBusy ? <span className="spinner small" /> : null}
          </div>

          <div className="workspace-list">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className={`workspace-card ${selectedWorkspaceId === workspace.id ? "selected" : ""}`}
                onClick={() => setSelectedWorkspaceId(workspace.id)}
              >
                <span className="workspace-monogram">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="workspace-card-text">
                  <strong>{workspace.name}</strong>
                  <small>{workspace.role}</small>
                </span>
              </button>
            ))}
            {workspaces.length === 0 && dataBusy ? (
              <div className="empty-panel">
                <p>Loading workspaces…</p>
              </div>
            ) : null}
            {workspaces.length === 0 && !dataBusy ? (
              <div className="empty-panel">
                <p>No workspaces yet.</p>
                <p className="muted-small">Create one below to make your first canvas.</p>
              </div>
            ) : null}
          </div>

          <form className="inline-create" onSubmit={(event) => void handleCreateWorkspace(event)}>
            <label htmlFor="workspace-name">New workspace</label>
            <div className="inline-row">
              <input
                id="workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="Design team"
                maxLength={80}
                required
              />
              <button type="submit" className="button-secondary" disabled={dataBusy}>
                Create
              </button>
            </div>
          </form>
        </section>

        <section className="documents-column">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{selectedWorkspace?.name ?? "Documents"}</p>
              <h2>Canvases</h2>
            </div>
            {selectedWorkspace ? (
              <span className={`role-badge role-${selectedWorkspace.role}`}>
                {selectedWorkspace.role}
              </span>
            ) : null}
          </div>

          {selectedWorkspace && selectedWorkspace.role !== "viewer" ? (
            <form
              className="inline-create document-create"
              onSubmit={(event) => void handleCreateDocument(event)}
            >
              <label htmlFor="document-title">Open a new canvas</label>
              <div className="inline-row">
                <input
                  id="document-title"
                  value={documentTitle}
                  onChange={(event) => setDocumentTitle(event.target.value)}
                  maxLength={160}
                  required
                />
                <button type="submit" className="button-primary" disabled={dataBusy}>
                  Create canvas
                </button>
              </div>
            </form>
          ) : null}

          {selectedWorkspace && selectedWorkspace.role !== "viewer" ? (
            <section className="template-section" aria-labelledby="template-heading">
              <div className="template-section-header">
                <div>
                  <p className="eyebrow">A useful first step</p>
                  <h3 id="template-heading">Start from a template</h3>
                </div>
                <label className="template-search">
                  <span className="visually-hidden">Search templates</span>
                  <input
                    value={templateQuery}
                    onChange={(event) => setTemplateQuery(event.target.value)}
                    placeholder="Search templates"
                    aria-label="Search templates"
                  />
                </label>
              </div>
              <div className="template-grid">
                {templates
                  .filter((template) =>
                    `${template.name} ${template.description}`
                      .toLowerCase()
                      .includes(templateQuery.trim().toLowerCase()),
                  )
                  .map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="template-card"
                      disabled={dataBusy}
                      onClick={() => void handleCreateFromTemplate(template.id)}
                    >
                      <span className={`template-preview template-${template.id}`} aria-hidden="true">
                        <span /><span /><span /><span />
                      </span>
                      <span className="template-copy">
                        <strong>{template.name}</strong>
                        <span>{template.description}</span>
                        <small>{template.nodeCount} editable objects</small>
                      </span>
                    </button>
                  ))}
                {templates.length === 0 && !dataBusy ? (
                  <p className="muted-small">Templates are unavailable right now. You can still start with a blank canvas.</p>
                ) : null}
                {templates.length > 0 &&
                !templates.some((template) =>
                  `${template.name} ${template.description}`
                    .toLowerCase()
                    .includes(templateQuery.trim().toLowerCase()),
                ) ? (
                  <p className="muted-small">No templates match that search.</p>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="document-grid">
            {documents.map((documentItem) => (
              <Link
                key={documentItem.id}
                href={`/documents/${documentItem.id}`}
                className="document-card"
              >
                <span className="document-preview" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="document-card-copy">
                  <strong>{documentItem.title}</strong>
                  <small>
                    Updated {formatDate(documentItem.updatedAt)} · {documentItem.role}
                  </small>
                </span>
              </Link>
            ))}
            {selectedWorkspace && documents.length === 0 && !dataBusy ? (
              <div className="empty-panel document-empty">
                <p>This workspace is empty.</p>
                <p className="muted-small">Create a canvas to invite everyone in.</p>
              </div>
            ) : null}
            {!selectedWorkspace ? (
              <div className="empty-panel document-empty">
                <p>Select or create a workspace first.</p>
              </div>
            ) : null}
          </div>

          <div className="dashboard-note">
            {selectedWorkspace?.role === "viewer"
              ? "You have view-only access in this workspace."
              : "Everyone with editor access can edit this canvas simultaneously. Presence is transient and never written to PostgreSQL."}
          </div>
        </section>
      </main>
    </div>
  );
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function safeNextPath(): string | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

function handleSessionError(
  error: unknown,
  setSession: (session: BrowserSession | null) => void,
  setError: (message: string | null) => void,
): void {
  if (error instanceof ApiRequestError && error.status === 401) {
    clearSession();
    setSession(null);
    setError("Your session expired. Sign in again.");
    return;
  }
  setError(errorMessage(error));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
