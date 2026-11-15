# Review of the nine suggested open-source repositories

Reviewed on 2026-11-15 for relevance to YTAgent's $0 AI video-production pipeline.

## Adopted

### OpenCV — visual preflight for generated scenes
Repository: https://github.com/opencv/opencv  
License: Apache-2.0.

The free GPU worker now samples seven frames from each generated scene before uploading it to Railway. It rejects unreadable clips and clips that are almost entirely black. It also reports a possible near-static scene for review without automatically rejecting subtle or intentionally static shots. This is a small, focused use of OpenCV rather than importing the full library into the Railway Node service.

Implementation:
- `gpu-worker/visual_quality.py`
- `gpu-worker/app.py`
- `gpu-worker/requirements.txt`

## Useful references, not runtime dependencies

### OpenCut
Repository: https://github.com/OpenCut-app/OpenCut  
License: MIT.

The current repository says it is being rewritten and that its Editor API, MCP server and headless/batch rendering are planned rather than ready. Its previous `opencut-classic` codebase is archived. Do not make YTAgent depend on either as its production renderer today. Revisit when the new headless rendering API is released and tested.

### Open-source games
Repository: https://github.com/bobeff/open-source-games.

A curated catalogue of open-source games and remakes. Useful as a source of public-domain/open-source game-story inspiration only after checking each game's individual license and facts. Not a video-generation engine and no code was imported.

### Open-source CS degree
Repository: https://github.com/ForrestKnight/open-source-cs.

A curated computer-science learning curriculum. Useful for developer education, not a runtime component.

### Open-source iOS apps
Repository: https://github.com/dkhamsing/open-source-ios-apps  
License: CC0-1.0.

A catalogue of iOS/iPadOS/watchOS/tvOS/visionOS applications. Not relevant to the server-side video pipeline. No app code was imported.

### Open-source macOS apps
Repository: https://github.com/serhii-londar/open-source-mac-os-apps.

A catalogue of macOS applications. Useful for desktop-software discovery, not a runtime component. Individual listed applications have their own licenses.

## Not adopted

### Xiaomi kernel source
Repository: https://github.com/MiCode/Xiaomi_Kernel_OpenSource.

Device-specific Android/Linux kernel source branches. It does not provide GPU compute or a general Android app runtime. No kernel code was imported. Do not use it for the Samsung A05 or YTAgent without an exact device codename, matching branch and verified license/build path.

### DIO open-source lab
Repository: https://github.com/digitalinnovationone/dio-lab-open-source.

A beginner contribution-training project and profile README directory. Useful as a learning reference for GitHub contributions, not application code. No files were copied.

### Welcome to Open Source
Repository: https://github.com/alisolanki/Welcome-to-Open-Source.

A beginner contribution directory whose README points contributors to a newer repository, `alisolanki/OpenSource-Github-Wall`. It is not an AI/video tool. No files were copied.

## Safety and cost boundary

No external repository was installed wholesale. No paid API, GPU rental, trial credit, subscription or payment method was used. No credentials were copied from these projects. The only code dependency added from this review is the open-source headless OpenCV Python package, used by the optional free GPU worker. Free GPU availability is still not guaranteed.
