import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadAsset } from "./api";

const workspaceId = "6a0ad4a9-9a9c-492b-a622-753dab379f56";
const assetId = "123e4567-e89b-42d3-a456-426614174000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("asset API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsupported image types before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["not an image"], "readme.txt", { type: "text/plain" });

    await expect(uploadAsset("test-token", workspaceId, file)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads authorized bytes and confirms the asset", async () => {
    const asset = {
      id: assetId,
      workspaceId,
      mimeType: "image/png",
      byteSize: 4,
      publicUrl: "https://assets.example/image.png",
      width: 2,
      height: 2,
      createdBy: "user-1",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          intent: {
            assetId,
            uploadUrl: `/v1/workspaces/${workspaceId}/assets/upload/key.png`,
            publicUrl: asset.publicUrl,
            method: "PUT",
            headers: { "content-type": "image/png" },
            expiresAt: "2025-01-01T00:15:00.000Z",
          },
        }, 201),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ asset }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["png!"], "image.png", { type: "image/png" });

    await expect(uploadAsset("test-token", workspaceId, file)).resolves.toEqual(asset);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: file,
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("rejects an upload target on another origin", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        intent: {
          assetId,
          uploadUrl: "https://attacker.example/upload",
          publicUrl: "https://attacker.example/image.png",
          method: "PUT",
          headers: {},
          expiresAt: "2025-01-01T00:15:00.000Z",
        },
      }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["png!"], "image.png", { type: "image/png" });

    await expect(uploadAsset("test-token", workspaceId, file)).rejects.toMatchObject({
      status: 502,
      code: "invalid_upload_target",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
