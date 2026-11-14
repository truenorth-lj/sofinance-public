import { redirect } from "next/navigation";
import { unifiedAppRedirect } from "@/lib/unified-pools/deep-link";

/** Fallback for requests that do not pass through the proxy. Preserve shared position links verbatim. */
export default async function AppHome({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  redirect(unifiedAppRedirect("/app", query.toString())!);
}
