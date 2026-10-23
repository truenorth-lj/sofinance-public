import { Children, isValidElement, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getPublicPngSize } from "@/lib/blog";
import { CANONICAL_SITE_URL } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";

function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith(CANONICAL_SITE_URL);
}

function toInternalPath(href: string): string {
  if (href.startsWith(CANONICAL_SITE_URL)) {
    const path = href.slice(CANONICAL_SITE_URL.length);
    return path === "" ? "/" : path;
  }
  return href;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  if (isInternalHref(href)) {
    return <Link href={toInternalPath(href)}>{children}</Link>;
  }
  return (
    <a href={href} {...EXTERNAL_LINK_PROPS}>
      {children}
    </a>
  );
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const items = Children.toArray(children).filter((child) => !(typeof child === "string" && child.trim() === ""));
  if (items.length === 1 && isValidElement(items[0]) && items[0].type === MarkdownImage) {
    return items[0];
  }
  return <p className="mt-4 first:mt-0">{children}</p>;
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  if (typeof src !== "string" || src === "") return null;
  const caption = alt ?? "";
  const size = getPublicPngSize(src);
  return (
    <figure className="my-8">
      <Image
        src={src}
        alt={caption}
        width={size.width}
        height={size.height}
        sizes="(max-width: 800px) 100vw, 720px"
        className="h-auto w-full rounded-2xl"
      />
      {caption ? (
        <figcaption className="mt-3 text-center font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-10 text-xl font-semibold tracking-[-0.02em] text-cream first:mt-0">{children}</h2>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-10 text-xl font-semibold tracking-[-0.02em] text-cream first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-8 text-lg font-semibold tracking-[-0.02em] text-cream">{children}</h3>
  ),
  p: MarkdownParagraph,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mt-4 list-disc space-y-2 pl-5 first:mt-0">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mt-4 list-decimal space-y-2 pl-5 first:mt-0">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="leading-7">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-cream">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em>{children}</em>,
  hr: () => <hr className="my-10 border-white/12" />,
  a: MarkdownLink,
  img: MarkdownImage,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-8 overflow-x-auto rounded-2xl border border-white/12">
      <table className="w-full min-w-[52rem] border-collapse text-left text-[13px] leading-6">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="bg-white/[0.04] text-cream">{children}</thead>
  ),
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="border-t border-white/10">{children}</tr>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-3 py-2.5 align-bottom font-semibold first:pl-4 last:pr-4">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-2.5 align-top text-cream/85 first:pl-4 last:pr-4">{children}</td>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="mt-4 border-l-2 border-lemon/70 pl-4 text-cream/85 italic">{children}</blockquote>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="font-data text-[0.9em] text-lemon">{children}</code>
  ),
};

export function BlogMarkdown({ body }: { body: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {body}
    </ReactMarkdown>
  );
}
