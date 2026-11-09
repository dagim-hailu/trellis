"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { DocumentDto } from "@trellis/shared";

import { CanvasEngine } from "@/components/CanvasEngine";
import { ApiRequestError, getDocument } from "@/lib/api";
import {
  clearSession,
  isSessionExpired,
  readSession,
  type BrowserSession,
} from "@/lib/session";

interface CanvasDocumentPageProps {
  documentId: string;
}

export function CanvasDocumentPage({ documentId }: CanvasDocumentPageProps) {
  const router = useRouter();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [document, setDocument] = useState<DocumentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(true);

  const redirectToLogin = useCallback(
    (reason?: "expired") => {
      const next = encodeURIComponent(window.location.pathname);
      const suffix = reason ? `&reason=${reason}` : "";
      router.replace(`/?next=${next}${suffix}`);
    },
    [router],
  );

  useEffect(() => {
    const stored = readSession();
    if (!stored || isSessionExpired(stored)) {
      if (stored) clearSession();
      redirectToLogin(stored ? "expired" : undefined);
      return;
    }

    let cancelled = false;
    setSession(stored);
    setRedirecting(false);

    getDocument(stored.accessToken, documentId)
      .then((result) => {
        if (cancelled) return;
        setDocument(result);
        window.document.title = `${result.title} · Trellis`;
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearSession();
          redirectToLogin("expired");
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The canvas could not be loaded.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [documentId, redirectToLogin]);

  const handleExpired = useCallback(() => {
    clearSession();
    redirectToLogin("expired");
  }, [redirectToLogin]);

  if (redirecting) {
    return (
      <main className="centered-page">
        <div className="loading-stack">
          <span className="spinner" />
          <p>Redirecting to sign in…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="centered-page">
        <div className="error-panel">
          <p className="eyebrow">Canvas unavailable</p>
          <h1>We could not open this canvas.</h1>
          <p>{error}</p>
          <a className="button-primary" href="/">
            Back to documents
          </a>
        </div>
      </main>
    );
  }

  if (!session || !document) {
    return (
      <main className="centered-page">
        <div className="loading-stack">
          <span className="spinner" />
          <p>Opening canvas…</p>
        </div>
      </main>
    );
  }

  return <CanvasEngine document={document} session={session} onExpired={handleExpired} />;
}
