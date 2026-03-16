const player = document.getElementById("player");

const lesson = {
  title: "",
  media: "",
  clips: []
};

let startTime = 0;
let endTime = 0;
let currentPlayInterval = null;
let editingClipIndex = -1;

// ---------- helpers ----------
function getStartInput() {
  return document.getElementById("startTime");
}

function getEndInput() {
  return document.getElementById("endTime");
}

function getLessonTitleInput() {
  return document.getElementById("lessonTitle");
}

function getJpInput() {
  return document.getElementById("jpText");
}

function getZhInput() {
  return document.getElementById("zhText");
}

function getCategoryInput() {
  return document.getElementById("category");
}

function getAddClipBtn() {
  return document.getElementById("addClip");
}

function getDeleteClipBtn() {
  return document.getElementById("deleteClipBtn");
}

function getCancelEditBtn() {
  return document.getElementById("cancelEditBtn");
}

function getEditorModeLabel() {
  return document.getElementById("editorModeLabel");
}

function parseTimeInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function formatTime(value) {
  return parseTimeInput(value).toFixed(1);
}

function syncStartEndFromInputs() {
  startTime = parseTimeInput(getStartInput().value);
  endTime = parseTimeInput(getEndInput().value);
}

function syncInputsFromStartEnd() {
  getStartInput().value = startTime.toFixed(1);
  getEndInput().value = endTime.toFixed(1);
}

function seekPlayer(time) {
  const t = Math.max(0, Number(time) || 0);
  player.currentTime = t;
}

function stopCurrentClipPlayback() {
  if (currentPlayInterval !== null) {
    player.removeEventListener("timeupdate", currentPlayInterval);
    currentPlayInterval = null;
  }
}

function clearClipEditorFields() {
  startTime = 0;
  endTime = 0;
  syncInputsFromStartEnd();

  getJpInput().value = "";
  getZhInput().value = "";
  getCategoryInput().value = "";
}

function setEditorMode(isEditing) {
  const addBtn = getAddClipBtn();
  const deleteBtn = getDeleteClipBtn();
  const cancelBtn = getCancelEditBtn();
  const modeLabel = getEditorModeLabel();

  if (isEditing) {
    addBtn.innerText = "Update Clip";
    deleteBtn.style.display = "inline-block";
    cancelBtn.style.display = "inline-block";
    modeLabel.innerText = `Editing clip #${editingClipIndex + 1}`;
  } else {
    addBtn.innerText = "Add Clip";
    deleteBtn.style.display = "none";
    cancelBtn.style.display = "none";
    modeLabel.innerText = "New clip mode";
  }
}

function exitEditMode(clearFields = true) {
  editingClipIndex = -1;
  setEditorMode(false);
  if (clearFields) {
    clearClipEditorFields();
  }
}

function loadClipIntoEditor(index) {
  const clip = lesson.clips[index];
  if (!clip) return;

  editingClipIndex = index;

  startTime = parseTimeInput(clip.start);
  endTime = parseTimeInput(clip.end);
  syncInputsFromStartEnd();

  getJpInput().value = clip.jp || "";
  getZhInput().value = clip.zh || "";
  getCategoryInput().value = clip.category || "";

  setEditorMode(true);
}

function resetEditorForNewLesson(selectedMediaName = "") {
  lesson.title = "";
  lesson.media = selectedMediaName;
  lesson.clips = [];

  getLessonTitleInput().value = "";
  exitEditMode(true);
  renderClips();
}

function loadLessonToEditor(data) {
  lesson.title = data.title || "";
  lesson.media = data.media || "";
  lesson.clips = Array.isArray(data.clips) ? data.clips : [];

  getLessonTitleInput().value = lesson.title;
  exitEditMode(true);
  renderClips();
}

// ---------- library ----------
async function initLibrary() {
  document.getElementById("mediaFolderLabel").innerText = "data/media";
  document.getElementById("lessonsFolderLabel").innerText = "data/lessons";

  await refreshMediaList();
  await refreshLessonList();
  syncInputsFromStartEnd();
  setEditorMode(false);
}

async function refreshMediaList() {
  const res = await fetch("/api/media");
  const data = await res.json();

  const files = (data.media || []).filter(f => !f.startsWith("."));
  const list = document.getElementById("mediaList");
  list.innerHTML = "";

  files.forEach((name) => {
    const li = document.createElement("li");
    li.innerText = name;
    li.style.cursor = "pointer";

    li.onclick = () => {
      player.src = `/media/${encodeURIComponent(name)}`;
      resetEditorForNewLesson(name);
    };

    list.appendChild(li);
  });
}

async function refreshLessonList() {
  const res = await fetch("/api/lessons");
  const data = await res.json();

  const files = (data.lessons || []).filter(f => !f.startsWith("."));
  const list = document.getElementById("lessonList");
  list.innerHTML = "";

  files.forEach((name) => {
    const li = document.createElement("li");
    li.innerText = name;
    li.style.cursor = "pointer";

    li.onclick = async () => {
      const res = await fetch(`/api/lessons/${encodeURIComponent(name)}`);
      const lessonData = await res.json();

      loadLessonToEditor(lessonData);

      if (lesson.media) {
        player.src = `/media/${encodeURIComponent(lesson.media)}`;
      }
    };

    list.appendChild(li);
  });
}

async function transcribeCurrentClip() {
  syncStartEndFromInputs();

  if (!lesson.media) {
    alert("請先在 Media Library 選一個媒體檔");
    return;
  }

  if (endTime <= startTime) {
    alert("End time 必須大於 Start time");
    return;
  }

  const btn = document.getElementById("transcribeClipBtn");
  const status = document.getElementById("transcribeStatus");

  try {
    btn.disabled = true;
    if (status) status.innerText = "Transcribing...";

    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mediaFilename: lesson.media,
        start: startTime,
        end: endTime,
        lang: "ja"
      })
    });

    const result = await res.json();

    if (!res.ok || !result.ok) {
      throw new Error(result.error || "Transcription failed");
    }

    getJpInput().value = result.text || "";

    if (status) {
      status.innerText = result.text
        ? "Transcription done."
        : "No speech detected.";
    }
  } catch (err) {
    console.error(err);
    alert(`轉錄失敗：\n${err.message || err}`);
    if (status) status.innerText = "Transcription failed.";
  } finally {
    btn.disabled = false;
  }
}

// ---------- import buttons ----------
document.getElementById("importMediaBtn").onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*,audio/*,.mkv,.mov,.m4a";

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("file", file);

    const res = await fetch("/api/upload-media", {
      method: "POST",
      body: form
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      alert(`media upload failed:\n${data.error || res.statusText}`);
      return;
    }

    await refreshMediaList();
    alert(`已匯入 media:\n${data.filename}`);
  };

  input.click();
};

document.getElementById("importLessonBtn").onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("file", file);

    const res = await fetch("/api/upload-lesson", {
      method: "POST",
      body: form
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      alert(`lesson upload failed:\n${data.error || res.statusText}`);
      return;
    }

    await refreshLessonList();
    alert(`已匯入 lesson:\n${data.filename}`);
  };

  input.click();
};

// ---------- start / end controls ----------
document.getElementById("setStart").onclick = () => {
  startTime = player.currentTime;
  syncInputsFromStartEnd();
};

document.getElementById("setEnd").onclick = () => {
  endTime = player.currentTime;
  syncInputsFromStartEnd();
};

document.getElementById("jumpStart").onclick = () => {
  syncStartEndFromInputs();
  seekPlayer(startTime);
};

document.getElementById("jumpEnd").onclick = () => {
  syncStartEndFromInputs();
  seekPlayer(endTime);
};

getStartInput().addEventListener("change", syncStartEndFromInputs);
getEndInput().addEventListener("change", syncStartEndFromInputs);

// ---------- add / update clip ----------
document.getElementById("addClip").onclick = () => {
  syncStartEndFromInputs();

  const jp = getJpInput().value.trim();
  const zh = getZhInput().value.trim();
  const category = getCategoryInput().value.trim();

  if (!lesson.media) {
    alert("請先在 Media Library 選一個媒體檔");
    return;
  }

  if (endTime <= startTime) {
    alert("End time 必須大於 Start time");
    return;
  }

  if (!jp) {
    alert("請輸入日文句子");
    return;
  }

  lesson.title = getLessonTitleInput().value.trim();

  const clipData = {
    start: startTime,
    end: endTime,
    jp,
    zh,
    category
  };

  if (editingClipIndex >= 0) {
    lesson.clips[editingClipIndex] = clipData;
  } else {
    lesson.clips.push(clipData);
  }

  renderClips();
  exitEditMode(true);
};

document.getElementById("deleteClipBtn").onclick = () => {
  if (editingClipIndex < 0) return;

  const ok = confirm(`確定要刪除第 ${editingClipIndex + 1} 個 clip 嗎？`);
  if (!ok) return;

  lesson.clips.splice(editingClipIndex, 1);
  renderClips();
  exitEditMode(true);
};

document.getElementById("cancelEditBtn").onclick = () => {
  exitEditMode(true);
};

document.getElementById("playEditorClipBtn").onclick = () => {
  syncStartEndFromInputs();

  if (endTime <= startTime) {
    alert("End time 必須大於 Start time");
    return;
  }

  playClip({
    start: startTime,
    end: endTime
  });
};

// ---------- save lesson ----------
document.getElementById("saveLesson").onclick = async () => {
  const title = getLessonTitleInput().value.trim();

  if (!title) {
    alert("請先輸入 Lesson title");
    return;
  }

  if (!lesson.media) {
    alert("請先選擇 Media");
    return;
  }

  if (lesson.clips.length === 0) {
    const ok = confirm("目前沒有任何 clips，仍要儲存嗎？");
    if (!ok) return;
  }

  lesson.title = title;

  try {
    const res = await fetch("/api/lessons", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(lesson)
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Save failed");
    }

    alert(`Saved:\n${data.filename}`);
    await refreshLessonList();
  } catch (err) {
    console.error(err);
    alert(`儲存失敗：\n${err.message || err}`);
  }
};

document.getElementById("transcribeClipBtn").onclick = transcribeCurrentClip;

// ---------- render clips ----------
function renderClips() {
  const list = document.getElementById("clipList");
  list.innerHTML = "";

  lesson.clips.forEach((clip, i) => {
    const li = document.createElement("li");
    li.className = "clip-card";

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText = `[${formatTime(clip.start)} - ${formatTime(clip.end)}]` +
      (clip.category ? `  |  ${clip.category}` : "");

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
        alert("End time 必須大於 Start time");
        return;
      }
      playClip(clip);
    };

    const editBtn = document.createElement("button");
    editBtn.innerText = "Edit";
    editBtn.onclick = () => {
      loadClipIntoEditor(i);
      seekPlayer(clip.start);
    };

    const delBtn = document.createElement("button");
    delBtn.innerText = "Delete";
    delBtn.onclick = () => {
      const ok = confirm(`確定要刪除第 ${i + 1} 個 clip 嗎？`);
      if (!ok) return;

      if (editingClipIndex === i) {
        exitEditMode(true);
      } else if (editingClipIndex > i) {
        editingClipIndex -= 1;
      }

      lesson.clips.splice(i, 1);
      renderClips();
      setEditorMode(editingClipIndex >= 0);
    };

    actions.append(playBtn, editBtn, delBtn);
    li.append(meta, jpDiv, zhDiv, actions);
    list.appendChild(li);
  });
}

// ---------- playback ----------
function playClip(clip) {
  stopCurrentClipPlayback();

  player.currentTime = clip.start;
  player.play();

  const onTimeUpdate = () => {
    if (player.currentTime >= clip.end || player.ended) {
      player.pause();
      stopCurrentClipPlayback();
    }
  };

  currentPlayInterval = onTimeUpdate;
  player.addEventListener("timeupdate", onTimeUpdate);
}

player.addEventListener("pause", stopCurrentClipPlayback);
player.addEventListener("ended", stopCurrentClipPlayback);

initLibrary();