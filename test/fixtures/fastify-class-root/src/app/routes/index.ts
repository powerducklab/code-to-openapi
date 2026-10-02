import posts from "./posts/index.js";

// Root route plugin mounted with a prefix; it fans out to feature plugins.
export const routes: any = async function (instance: any): Promise<void> {
  instance.register(posts, { prefix: "/posts" });
};
