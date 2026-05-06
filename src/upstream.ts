export interface ShareMetadata {
  item_id: string;
  item_name: string | null;
  item_type: "file" | "folder";
  token: string;
  has_password: boolean;
  expires_at: number | null;
}

export interface FolderEntry {
  id: string;
  name: string;
}

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  modified_at?: number;
}

export interface FolderListing {
  folders: FolderEntry[];
  files: FileEntry[];
}

export type ListingResult =
  | { kind: "ok"; data: FolderListing }
  | { kind: "password-required" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "not-folder-share" }
  | { kind: "upstream-error"; status: number; detail?: string };

export type MetadataResult =
  | { kind: "ok"; data: ShareMetadata; setCookie: string | null }
  | { kind: "password-required" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "upstream-error"; status: number; detail?: string };

export type VerifyResult =
  | { kind: "ok"; data: ShareMetadata; setCookie: string | null }
  | { kind: "wrong-password" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "upstream-error"; status: number; detail?: string };

export class UpstreamClient {
  constructor(private readonly baseUrl: string) {}

  async getMetadata(token: string, cookieHeader?: string): Promise<MetadataResult> {
    const url = `${this.baseUrl}/api/s/${encodeURIComponent(token)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cookieHeader) headers.Cookie = cookieHeader;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      return {
        kind: "upstream-error",
        status: 502,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    return this.interpretMetadataResponse(res, false) as Promise<MetadataResult>;
  }

  async verifyPassword(token: string, password: string): Promise<VerifyResult> {
    const url = `${this.baseUrl}/api/s/${encodeURIComponent(token)}/verify`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ password }),
      });
    } catch (err) {
      return {
        kind: "upstream-error",
        status: 502,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    return this.interpretMetadataResponse(res, true) as Promise<VerifyResult>;
  }

  async download(
    token: string,
    cookieHeader?: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}/api/s/${encodeURIComponent(token)}/download`;
    return fetch(url, {
      headers: this.passThroughHeaders(cookieHeader, rangeHeader, ifNoneMatchHeader),
    });
  }

  async listContents(
    token: string,
    folderId: string | null,
    cookieHeader?: string,
  ): Promise<ListingResult> {
    const t = encodeURIComponent(token);
    const url =
      folderId == null
        ? `${this.baseUrl}/api/s/${t}/contents`
        : `${this.baseUrl}/api/s/${t}/contents/${encodeURIComponent(folderId)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });
    } catch (err) {
      return {
        kind: "upstream-error",
        status: 502,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.ok) {
      try {
        const data = (await res.json()) as FolderListing;
        return { kind: "ok", data };
      } catch (err) {
        return {
          kind: "upstream-error",
          status: 502,
          detail: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (res.status === 400) return { kind: "not-folder-share" };
    if (res.status === 401) return { kind: "password-required" };
    if (res.status === 410) return { kind: "expired" };
    if (res.status === 404) return { kind: "not-found" };

    let detail: string | undefined;
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore
    }
    return { kind: "upstream-error", status: res.status, detail };
  }

  async downloadFileInFolder(
    token: string,
    fileId: string,
    cookieHeader?: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}/api/s/${encodeURIComponent(token)}/file/${encodeURIComponent(fileId)}`;
    return fetch(url, {
      headers: this.passThroughHeaders(cookieHeader, rangeHeader, ifNoneMatchHeader),
    });
  }

  async downloadZip(
    token: string,
    folderId: string | null,
    cookieHeader?: string,
  ): Promise<Response> {
    const t = encodeURIComponent(token);
    const url =
      folderId == null
        ? `${this.baseUrl}/api/s/${t}/zip`
        : `${this.baseUrl}/api/s/${t}/zip/${encodeURIComponent(folderId)}`;
    return fetch(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  }

  private passThroughHeaders(
    cookieHeader?: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Record<string, string> {
    const h: Record<string, string> = {};
    if (cookieHeader) h.Cookie = cookieHeader;
    if (rangeHeader) h.Range = rangeHeader;
    if (ifNoneMatchHeader) h["If-None-Match"] = ifNoneMatchHeader;
    return h;
  }

  private async interpretMetadataResponse(
    res: Response,
    isVerify: boolean,
  ): Promise<MetadataResult | VerifyResult> {
    const setCookie = res.headers.get("set-cookie");

    if (res.ok) {
      try {
        const data = (await res.json()) as ShareMetadata;
        return { kind: "ok", data, setCookie };
      } catch (err) {
        return {
          kind: "upstream-error",
          status: 502,
          detail: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (res.status === 401) {
      return isVerify ? { kind: "wrong-password" } : { kind: "password-required" };
    }
    if (res.status === 410) return { kind: "expired" };
    if (res.status === 404) return { kind: "not-found" };

    let detail: string | undefined;
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore
    }
    return { kind: "upstream-error", status: res.status, detail };
  }
}
