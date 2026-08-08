import { expect, test } from "bun:test";

const dockerfile = await Bun.file(
  new URL("./Dockerfile.worker", import.meta.url),
).text();
const hostedDockerfile = await Bun.file(
  new URL("./Dockerfile", import.meta.url),
).text();

test("worker image includes conservative media processing tools", () => {
  for (const packageName of [
    "ffmpeg",
    "file",
    "jpegoptim",
    "jq",
    "libimage-exiftool-perl",
    "optipng",
    "webp",
  ]) {
    expect(dockerfile).toContain(`    ${packageName} \\\n`);
  }
});

test("worker image includes a minimal Python runtime", () => {
  for (const packageName of ["python3", "python3-venv"]) {
    expect(dockerfile).toContain(`    ${packageName} \\\n`);
  }
});

test("images copy code from the consolidated source layout", () => {
  expect(dockerfile).toContain(
    "COPY --chown=bun:bun src/chatbot /app/src/chatbot",
  );
  expect(dockerfile).not.toContain("COPY --chown=bun:bun lib /app/lib");
  expect(hostedDockerfile).toContain(
    "COPY --from=builder --chown=bun:bun /app/src ./src",
  );
  expect(hostedDockerfile).not.toContain("/app/lib");
  expect(hostedDockerfile).not.toContain("/app/data");
});
