// Blog posts in the database: validation, saving, renaming, drafts, and the
// one-time import of the legacy content/blog files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { deletePost, ensureSeeded, getPost, importPostsFromDir, listPosts, parsePostFile, savePost, slugify, validatePost } from "../blog";

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-"));
  ensureSeeded(db, dir); // an empty seed dir: the real content/ must not leak into tests
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ok = (over: Partial<{ slug: string; title: string; date: string; body: string; published: boolean }> = {}) => {
  const v = validatePost({ title: "The pool is people", date: "2026-07-07", body: "Hello **world**", ...over });
  if (!v.ok) throw new Error(v.error);
  return v.post;
};

describe("blog", () => {
  it("makes slugs from titles and validates the rest", () => {
    expect(slugify("The Pool is People!")).toBe("the-pool-is-people");
    expect(slugify("  --Ünïcode & co--  ")).toBe("unicode-co");
    expect(ok().slug).toBe("the-pool-is-people");
    expect(ok({ slug: "custom-slug" }).slug).toBe("custom-slug");
    expect(validatePost({ title: "", date: "2026-07-07" })).toMatchObject({ ok: false });
    expect(validatePost({ title: "x", date: "07/07/2026" })).toMatchObject({ ok: false });
    expect(validatePost({ title: "x", date: "2026-07-07", slug: "Bad Slug" })).toMatchObject({ ok: false });
    expect(validatePost({ title: "x", date: "2026-07-07", body: "a".repeat(64 * 1024 + 1) })).toMatchObject({ ok: false });
    expect(ok({ body: "line one\r\nline two\r\n" }).body).toBe("line one\nline two");
  });

  it("saves, updates, lists newest first, and hides drafts from the public list", () => {
    expect(savePost(db, ok())).toMatchObject({ ok: true });
    expect(savePost(db, ok({ slug: "older", title: "Older", date: "2026-01-01" }))).toMatchObject({ ok: true });
    expect(savePost(db, ok({ slug: "secret", title: "Secret", date: "2026-12-31", published: false }))).toMatchObject({ ok: true });
    expect(listPosts(db).map((p) => p.slug)).toEqual(["the-pool-is-people", "older"]);
    expect(listPosts(db, { drafts: true }).map((p) => p.slug)).toEqual(["secret", "the-pool-is-people", "older"]);
    expect(getPost(db, "secret")).toBeNull();
    expect(getPost(db, "secret", { drafts: true })?.title).toBe("Secret");
    const before = getPost(db, "older")!;
    const updated = savePost(db, ok({ slug: "older", title: "Older, edited", date: "2026-01-01" }));
    expect(updated).toMatchObject({ ok: true, post: { title: "Older, edited", createdAt: before.createdAt } });
    expect(deletePost(db, "older")).toBe(true);
    expect(deletePost(db, "older")).toBe(false);
    expect(listPosts(db).map((p) => p.slug)).toEqual(["the-pool-is-people"]);
  });

  it("renames without losing the creation time and refuses to clobber another post", () => {
    savePost(db, ok({ slug: "one", title: "One" }));
    savePost(db, ok({ slug: "two", title: "Two" }));
    const created = getPost(db, "one")!.createdAt;
    expect(savePost(db, ok({ slug: "uno", title: "Uno" }), "one")).toMatchObject({ ok: true, post: { slug: "uno", createdAt: created } });
    expect(getPost(db, "one")).toBeNull();
    expect(savePost(db, ok({ slug: "two", title: "Clobber" }), "uno")).toMatchObject({ ok: false });
    expect(getPost(db, "uno")?.title).toBe("Uno");
  });

  it("imports the legacy files once, skipping what it can't parse or already has", () => {
    fs.writeFileSync(path.join(dir, "2026-07-07-the-pool-is-people.md"), "---\ntitle: The pool is people\ndate: 2026-07-07\n---\n\nBody here.\n");
    fs.writeFileSync(path.join(dir, "26-08-21-Item-Veiwer-Overhaul.md"), "---\ntitle: Item viewer\ndate: 2026-08-21\n---\nNewer.");
    fs.writeFileSync(path.join(dir, "broken.md"), "no front matter");
    fs.writeFileSync(path.join(dir, "notes.txt"), "---\ntitle: nope\ndate: 2026-01-01\n---\nignored");
    expect(importPostsFromDir(db, dir)).toBe(2);
    expect(listPosts(db).map((p) => [p.slug, p.title])).toEqual([["26-08-21-item-veiwer-overhaul", "Item viewer"], ["2026-07-07-the-pool-is-people", "The pool is people"]]);
    savePost(db, ok({ slug: "2026-07-07-the-pool-is-people", title: "Edited on the site", date: "2026-07-07" }));
    expect(importPostsFromDir(db, dir)).toBe(0); // the database wins from now on
    expect(getPost(db, "2026-07-07-the-pool-is-people")?.title).toBe("Edited on the site");
    expect(importPostsFromDir(db, path.join(dir, "missing"))).toBe(0);
    expect(parsePostFile("x", "---\ntitle: T\ndate: 2026-13-45\n---\nbody")).toEqual({ slug: "x", title: "T", date: "2026-13-45", body: "body" });
  });
});
