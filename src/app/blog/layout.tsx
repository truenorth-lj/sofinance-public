import type { ReactNode } from "react";
import { BlogShell } from "@/components/blog/blog-shell";

export default function BlogLayout({ children }: { children: ReactNode }) {
  return <BlogShell>{children}</BlogShell>;
}
