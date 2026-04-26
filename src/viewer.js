const player = document.getElementById("player");

const viewerState = {
  lessonFolderId: null,
  lesson: null,
  clips: [],
  clipCurrentPage: 1,
  clipPageSize: 10
};

let currentPlayInterval = null;
let appMessageTimer = null;

function showAppMessage(message, type = "info") {
  const el = document.getElementById("appMessage");
  window.clearTimeout(appMessageTimer);
  el.textContent = message;
  el.className = `app-message ${type}`.trim();

  appMessageTimer = window.setTimeout(() => {
    el.classList.add("hidden");
  }, type === "error" ? 6500 : 3500);
}

function parseTimeInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function formatTime(value) {
  return parseTimeInput(value).toFixed(1);
}

function buildFolderTree(folders) {
  const byParent = new Map();

  folders.forEach((folder) => {
    const key = folder.parent_id ?? null;
    if (!byParent.has(key)) {
      byParent.set(key, []);
    }
    byParent.get(key).push(folder);
  });

  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  const result = [];

  function walk(parentId, depth) {
    const children = byParent.get(parentId) || [];
    for (const child of children) {
      result.push({ ...child, depth });
      walk(child.id, depth + 1);
    }
  }

  walk(null, 0);
  return result;
}

function renderFolderSelect(selectEl, folders, selectedId) {
  selectEl.innerHTML = "";

  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.innerText = "(root)";
  selectEl.appendChild(rootOption);

  buildFolderTree(folders).forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.innerText = `${"　".repeat(folder.depth)}${folder.name}`;

    if (selectedId != null && Number(selectedId) === folder.id) {
      option.selected = true;
    }

    selectEl.appendChild(option);
  });
}

async function fetchFolders(kind) {
  const res = await fetch(`/api/folders?kind=${encodeURIComponent(kind)}`);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Load folders failed");
  }

  return data.folders || [];
}

async function refreshFolderSelect() {
  const folders = await fetchFolders("lesson");
  renderFolderSelect(
    document.getElementById("lessonFolderSelect"),
    folders,
    viewerState.lessonFolderId
  );
}

async function refreshLessonList() {
  const query = viewerState.lessonFolderId != null
    ? `?folder_id=${viewerState.lessonFolderId}`
    : "";

  const res = await fetch(`/api/lessons${query}`);
  const lessons = await res.json();

  if (!res.ok || !Array.isArray(lessons)) {
    throw new Error(lessons.error || "Load lessons failed");
  }

  const list = document.getElementById("lessonList");
  list.innerHTML = "";

  if (lessons.length === 0) {
    const empty = document.createElement("li");
    empty.className = "library-card";
    empty.innerText = "No lessons in this folder";
    list.appendChild(empty);
    return;
  }

  lessons.forEach((lessonItem) => {
    const li = document.createElement("li");
    li.className = "library-card";

    const title = document.createElement("div");
    title.className = "library-card-title";
    title.innerText = lessonItem.title;
    title.onclick = () => openLesson(lessonItem.id);

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText = lessonItem.media_filename || "No media";

    li.append(title, meta);
    list.appendChild(li);
  });
}

async function openLesson(id) {
  const res = await fetch(`/api/lessons/${id}`);
  const lesson = await res.json();

  if (!res.ok) {
    throw new Error(lesson.error || "Load lesson failed");
  }

  viewerState.lesson = lesson;
  viewerState.clips = Array.isArray(lesson.clips) ? lesson.clips : [];
  viewerState.clipCurrentPage = 1;

  document.getElementById("lessonTitle").innerText = lesson.title || "Untitled Lesson";
  document.getElementById("lessonMeta").innerText = lesson.media_filename || "No media selected";

  const editLink = document.getElementById("editCurrentLessonLink");
  editLink.href = `editor.html?lessonId=${encodeURIComponent(lesson.id)}`;
  editLink.classList.remove("hidden");

  stopCurrentClipPlayback();
  if (lesson.media_filename) {
    player.src = `/media/${encodeURIComponent(lesson.media_filename)}`;
  } else {
    player.removeAttribute("src");
    player.load();
  }

  renderClips();
}

function getSortedClips() {
  return [...viewerState.clips].sort(
    (a, b) => parseTimeInput(a.start) - parseTimeInput(b.start)
  );
}

function getClipPageCount(totalClips = viewerState.clips.length) {
  return Math.max(1, Math.ceil(totalClips / viewerState.clipPageSize));
}

function clampClipPage(totalClips = viewerState.clips.length) {
  viewerState.clipCurrentPage = Math.min(
    Math.max(1, viewerState.clipCurrentPage),
    getClipPageCount(totalClips)
  );
}

function renderClips() {
  const list = document.getElementById("clipList");
  const pagination = document.getElementById("clipPagination");
  list.innerHTML = "";

  const sortedClips = getSortedClips();
  const totalClips = sortedClips.length;
  const pageCount = getClipPageCount(totalClips);
  clampClipPage(totalClips);

  const pageStart = (viewerState.clipCurrentPage - 1) * viewerState.clipPageSize;
  const visibleClips = sortedClips.slice(pageStart, pageStart + viewerState.clipPageSize);

  if (!viewerState.lesson) {
    const li = document.createElement("li");
    li.className = "clip-card";
    li.innerText = "Choose a lesson from the left.";
    list.appendChild(li);
    renderClipPagination(pagination, 0, 1, 0, 0);
    return;
  }

  visibleClips.forEach((clip, i) => {
    const displayIndex = pageStart + i + 1;
    const li = document.createElement("li");
    li.className = "clip-card";

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText = `#${displayIndex} [${formatTime(clip.start)} - ${formatTime(clip.end)}]` +
      (clip.category ? ` | ${clip.category}` : "");

    const jpDiv = document.createElement("div");
    jpDiv.className = "clip-jp";
    jpDiv.innerText = clip.jp || "";

    const zhDiv = document.createElement("div");
    zhDiv.className = "clip-zh";
    zhDiv.innerText = clip.zh || "";

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const playBtn = document.createElement("button");
    playBtn.innerText = "Play";
    playBtn.onclick = () => {
      if (parseTimeInput(clip.end) <= parseTimeInput(clip.start)) {
        showAppMessage("這個 clip 的時間範圍不合法。", "error");
        return;
      }
      playClip(clip);
    };

    actions.appendChild(playBtn);
    li.append(meta, jpDiv, zhDiv, actions);
    list.appendChild(li);
  });

  renderClipPagination(pagination, totalClips, pageCount, pageStart, visibleClips.length);
}

function renderClipPagination(container, totalClips, pageCount, pageStart, visibleCount) {
  container.innerHTML = "";

  const summary = document.createElement("span");
  summary.className = "clip-page-summary";
  summary.innerText = totalClips === 0
    ? "0 clips"
    : `${pageStart + 1}-${pageStart + visibleCount} / ${totalClips} clips`;

  const controls = document.createElement("div");
  controls.className = "clip-page-controls";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.innerText = "Prev";
  prevBtn.disabled = viewerState.clipCurrentPage <= 1;
  prevBtn.onclick = () => {
    viewerState.clipCurrentPage -= 1;
    renderClips();
  };

  const pageLabel = document.createElement("span");
  pageLabel.className = "clip-page-label";
  pageLabel.innerText = `Page ${viewerState.clipCurrentPage} / ${pageCount}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.innerText = "Next";
  nextBtn.disabled = viewerState.clipCurrentPage >= pageCount;
  nextBtn.onclick = () => {
    viewerState.clipCurrentPage += 1;
    renderClips();
  };

  controls.append(prevBtn, pageLabel, nextBtn);
  container.append(summary, controls);
}

function stopCurrentClipPlayback() {
  if (currentPlayInterval !== null) {
    player.removeEventListener("timeupdate", currentPlayInterval);
    currentPlayInterval = null;
  }
}

function playClip(clip) {
  stopCurrentClipPlayback();

  player.currentTime = parseTimeInput(clip.start);
  player.play();

  const onTimeUpdate = () => {
    if (player.currentTime >= parseTimeInput(clip.end) || player.ended) {
      player.pause();
      stopCurrentClipPlayback();
    }
  };

  currentPlayInterval = onTimeUpdate;
  player.addEventListener("timeupdate", onTimeUpdate);
}

document.getElementById("lessonFolderSelect").addEventListener("change", async (event) => {
  viewerState.lessonFolderId = event.target.value ? Number(event.target.value) : null;
  await refreshLessonList();
});

document.getElementById("clipPageSize").onchange = (event) => {
  viewerState.clipPageSize = Number(event.target.value) || 10;
  viewerState.clipCurrentPage = 1;
  renderClips();
};

player.addEventListener("pause", stopCurrentClipPlayback);
player.addEventListener("ended", stopCurrentClipPlayback);

async function bootstrap() {
  await refreshFolderSelect();
  await refreshLessonList();
  renderClips();
}

bootstrap().catch((err) => {
  console.error(err);
  showAppMessage(`初始化閱覽頁失敗：\n${err.message || err}`, "error");
});
