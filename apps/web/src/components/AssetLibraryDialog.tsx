"use client";

import { useEffect, useRef, useState } from "react";

import type { AssetDto } from "@trellis/shared";

import { ApiRequestError, listAssets, loadAssetPreview, uploadAsset } from "@/lib/api";

interface AssetLibraryDialogProps {
  open: boolean;
  workspaceId: string;
  accessToken: string;
  canUpload: boolean;
  onClose: () => void;
  onInsert: (asset: AssetDto) => void;
}

export function AssetLibraryDialog({
  open,
  workspaceId,
  accessToken,
  canUpload,
  onClose,
  onInsert,
}: AssetLibraryDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAssets(accessToken, workspaceId)
      .then((result) => {
        if (!cancelled) setAssets(result);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, open, workspaceId]);

  if (!open) return null;

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const asset = await uploadAsset(accessToken, workspaceId, file);
      setAssets((current) => [asset, ...current.filter((entry) => entry.id !== asset.id)]);
      onInsert(asset);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div
      className="palette-scrim asset-dialog-scrim"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="asset-dialog glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="asset-dialog-header">
          <div>
            <p className="eyebrow">Workspace library</p>
            <h2 id="asset-dialog-title">Add an image</h2>
            <p>Reuse an image with your team or upload a new one.</p>
          </div>
          <button type="button" className="button-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        {canUpload ? (
          <div className="asset-upload-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              aria-label="Choose an image to upload"
              disabled={uploading}
              onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
            />
            <span>PNG, JPEG, WebP, or SVG · up to 25 MiB</span>
          </div>
        ) : (
          <p className="asset-dialog-note">You can browse this library, but only editors can upload.</p>
        )}

        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {loading ? <p className="asset-dialog-note">Loading workspace images…</p> : null}
        {uploading ? <p className="asset-dialog-note" role="status">Uploading and preparing your image…</p> : null}

        {!loading && assets.length === 0 ? (
          <div className="asset-empty-state">
            <strong>No images in this workspace yet</strong>
            <span>Upload a PNG, JPEG, WebP, or SVG to place it on the canvas.</span>
          </div>
        ) : null}

        {assets.length > 0 ? (
          <div className="asset-grid" aria-label="Workspace images">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className="asset-card"
                onClick={() => onInsert(asset)}
                aria-label={`Insert image ${asset.id}`}
              >
                <span className="asset-card-preview" aria-hidden="true">
                  <AssetPreview asset={asset} accessToken={accessToken} />
                </span>
                <span className="asset-card-meta">
                  {asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.mimeType.replace("image/", "").toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AssetPreview({ asset, accessToken }: { asset: AssetDto; accessToken: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    loadAssetPreview(accessToken, asset.id)
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accessToken, asset.id]);

  if (failed) {
    return <span className="asset-preview-error" title="The image preview could not be loaded">Preview unavailable</span>;
  }
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span aria-hidden="true">Loading preview…</span>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "The image library could not be loaded.";
}
