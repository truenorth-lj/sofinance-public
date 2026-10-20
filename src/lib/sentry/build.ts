export type SentryUploadInput = {
  authToken?: string;
  org?: string;
  project?: string;
  ci?: string;
};

export function sentrySourceMapsEnabled(input: SentryUploadInput): boolean {
  return Boolean(input.authToken?.trim() && input.org?.trim() && input.project?.trim());
}

/**
 * Options for `withSentryConfig`. Source-map upload and release creation run
 * only when auth token, org, and project are all set. `errorHandler` is a no-op
 * so a missing or unreachable Sentry project cannot fail `next build`.
 */
export function sentryBuildOptions(input: SentryUploadInput) {
  const upload = sentrySourceMapsEnabled(input);
  return {
    org: input.org,
    project: input.project,
    authToken: input.authToken,
    silent: !upload || !input.ci,
    telemetry: false,
    widenClientFileUpload: upload,
    sourcemaps: { disable: !upload },
    release: { create: upload, finalize: upload },
    errorHandler: () => undefined,
  };
}
