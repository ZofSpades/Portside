Dockerfile templates for the static-site and Node.js build paths. `{{PLACEHOLDER}}` tokens are
filled in by `packages/docker/src/templates.ts` based on project detection
(`packages/core/src/detect.ts`). Dockerfile-based projects use their own Dockerfile as-is and
never go through a template.
