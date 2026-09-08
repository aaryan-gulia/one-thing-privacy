const imageExtensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

function requestUuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Request ID must be a UUID");
  return value;
}

export class AgentApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.code = code;
  }
}

function rejectPrivilegedKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A nonempty credential is required");
  }
  let role;
  try {
    role = JSON.parse(
      atob(value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ).role;
  } catch {
    // Opaque publishable keys and user tokens are verified by the server.
  }
  if (
    value.startsWith("sb_secret_") ||
    role === "service_role" ||
    role === "supabase_admin"
  ) {
    throw new Error("Agent clients cannot use privileged credentials");
  }
}

function caption(value, optional = false) {
  if (
    optional &&
    (value === null || value === undefined || value.trim() === "")
  )
    return null;
  if (
    typeof value !== "string" ||
    [...value.trim()].length < 1 ||
    [...value.trim()].length > 120
  ) {
    throw new Error("A caption must contain 1–120 characters");
  }
  return value.trim();
}

/**
 * An ordinary user-session client. No disk storage, admin privileges or retries.
 * Supply an async accessToken callback when your host rotates credentials.
 */
export function createAgentClient({
  url,
  publishableKey,
  accessToken,
  timeoutMs = 30_000,
}) {
  const base = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error(
      "Use an HTTPS project origin (HTTP is allowed only on loopback)",
    );
  }
  rejectPrivilegedKey(publishableKey);

  async function request(
    path,
    { body, authenticated = true, method = "POST", headers = {} } = {},
  ) {
    const requestHeaders = { apikey: publishableKey, ...headers };
    if (authenticated) {
      const token =
        typeof accessToken === "function" ? await accessToken() : accessToken;
      if (!token)
        throw new Error("An individual user access token is required");
      rejectPrivilegedKey(token);
      requestHeaders.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined && !(body instanceof Blob)) {
      requestHeaders["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, base), {
      method,
      headers: requestHeaders,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new AgentApiError(
        "API returned invalid JSON",
        response.status,
        "invalid_response",
      );
    }
    if (!response.ok) {
      throw new AgentApiError(
        result?.message ??
          result?.msg ??
          result?.error_description ??
          "API request failed",
        response.status,
        result?.code ?? result?.error_code ?? "request_failed",
      );
    }
    return result;
  }

  const rpc = (name, body = {}) => request(`/rest/v1/rpc/${name}`, { body });
  return {
    requestOtp: (email) =>
      request("/auth/v1/otp", {
        authenticated: false,
        body: { email, create_user: true },
      }),
    verifyOtp: (email, token) =>
      request("/auth/v1/verify", {
        authenticated: false,
        body: { email, token, type: "email" },
      }),
    refreshSession: (refreshToken) =>
      request("/auth/v1/token?grant_type=refresh_token", {
        authenticated: false,
        body: { refresh_token: refreshToken },
      }),
    getProfile: () => rpc("get_my_profile"),
    saveProfile: ({ username, displayName, timezone }) =>
      rpc("upsert_my_profile", {
        p_username: username,
        p_display_name: displayName,
        p_timezone: timezone,
      }),
    getToday: () => rpc("get_my_today"),
    getLatestIncomplete: () => rpc("get_latest_incomplete_goal"),
    listHistory: () => rpc("list_my_goal_history"),
    listFriendFeed: () => rpc("list_friend_goal_feed"),
    async createGoal(text) {
      return rpc("create_text_goal", { p_caption: caption(text) });
    },
    async correctGoal(entryId, text) {
      return rpc("correct_text_goal", {
        p_entry_id: entryId,
        p_caption: caption(text),
      });
    },
    carryGoal: (entryId) => rpc("carry_daily_goal", { p_entry_id: entryId }),
    createGoalV2: async (text, requestId) =>
      rpc("create_text_goal_v2", {
        p_caption: caption(text),
        p_request_id: requestUuid(requestId),
      }),
    carryGoalV2: async (entryId, requestId) =>
      rpc("carry_goal_v2", {
        p_entry_id: entryId,
        p_request_id: requestUuid(requestId),
      }),
    listCompletionFeed: async ({ limit = 20, before } = {}) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new Error("Feed limit must be 1..50");
      if (
        before !== undefined &&
        (typeof before.completedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
            before.completedAt,
          ) ||
          !Number.isFinite(Date.parse(before.completedAt)))
      )
        throw new Error("Invalid completion cursor timestamp");
      return rpc("list_completion_feed_v2", {
        p_limit: limit,
        p_before_completed_at: before?.completedAt ?? null,
        p_before_id: before === undefined ? null : requestUuid(before.id),
      });
    },
    async completeGoal(entryId, proofPhotoPath, note = null) {
      return rpc("complete_daily_goal", {
        p_entry_id: entryId,
        p_proof_photo_path: proofPhotoPath,
        p_note: caption(note, true),
      });
    },
    removeGoal: (entryId) => rpc("remove_goal_entry", { p_entry_id: entryId }),
    setCheered: (entryId, cheered) =>
      rpc("set_goal_cheer", { p_entry_id: entryId, p_cheered: cheered }),
    searchUsername: (username) =>
      rpc("search_profile_by_username", { p_username: username }),
    listFriendships: () => rpc("list_friendships"),
    sendFriendRequest: (profileId) =>
      rpc("send_friend_request", { p_target_user_id: profileId }),
    acceptFriendRequest: (relationshipId) =>
      rpc("accept_friend_request", { p_relationship_id: relationshipId }),
    removeFriend: (relationshipId) =>
      rpc("remove_friend", { p_relationship_id: relationshipId }),
    blockUser: (profileId) =>
      rpc("block_user", { p_target_user_id: profileId }),
    async uploadProof(photo) {
      if (!(photo instanceof Blob) || !imageExtensions.has(photo.type))
        throw new Error("Proof must be a JPEG, PNG, HEIC or HEIF image Blob");
      if (photo.size < 1 || photo.size > 10 * 1024 * 1024)
        throw new Error("Proof image size must be 1 byte through 10 MiB");
      const user = await request("/auth/v1/user", { method: "GET" });
      if (!/^[a-f0-9-]{36}$/i.test(user?.id ?? ""))
        throw new AgentApiError(
          "API returned invalid user",
          502,
          "invalid_response",
        );
      const path = `${user.id}/proof/${crypto.randomUUID()}.${imageExtensions.get(photo.type)}`;
      await request(`/storage/v1/object/goal-media/${path}`, {
        body: photo,
        headers: { "Content-Type": photo.type, "x-upsert": "false" },
      });
      return path;
    },
    async signedProofUrl(path, expiresIn = 300) {
      if (
        typeof path !== "string" ||
        !path ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid proof path");
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600)
        throw new Error("Signed URL expiry must be 1–3600 seconds");
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const result = await request(
        `/storage/v1/object/sign/goal-media/${encoded}`,
        { body: { expiresIn } },
      );
      return new URL(`/storage/v1${result.signedURL}`, base).href;
    },
  };
}
