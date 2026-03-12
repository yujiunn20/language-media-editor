const player = document.getElementById("player");

const lesson = {
  title: "",
  media: "",
  clips: []
};

let startTime = 0;
let endTime = 0;
let currentPlayInterval = null;

// ---------- helpers ----------
function getStartInput() {
  return document.getElementById("startTime");
}

function getEndInput() {
  return document.getElementById("endTime");
}

function parseTimeInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
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
    clearInterval(currentPlayInterval);
    currentPlayInterval = null;
  }
}

function resetEditorForNewLesson(selectedMediaName = "") {
  lesson.title = "";
  lesson.media = selectedMediaName;
  lesson.clips = [];

  startTime = 0;
  endTime = 0;
  syncInputsFromStartEnd();

  document.getElementById("lessonTitle").value = "";
  document.getElementById("jpText").value = "";
  document.getElementById("zhText").value = "";
  document.getElementById("category").value = "";

  renderClips();
}

function loadLessonToEditor(data) {
  lesson.title = data.title || "";
  lesson.media = data.media || "";
  lesson.clips = Array.isArray(data.clips) ? data.clips : [];

  document.getElementById("lessonTitle").value = lesson.title;
  document.getElementById("jpText").value = "";
  document.getElementById("zhText").value = "";
  document.getElementById("category").value = "";

  startTime = 0;
  endTime = 0;
  syncInputsFromStartEnd();

  renderClips();
}

// ---------- library ----------
async function initLibrary() {
  const paths = await window.electronAPI.getLibraryPaths();
  document.getElementById("mediaFolderLabel").innerText = paths.mediaFolderPath;
  document.getElementById("lessonsFolderLabel").innerText = paths.lessonsFolderPath;

  await refreshMediaList();
  await refreshLessonList();
  syncInputsFromStartEnd();
}

async function refreshMediaList() {
  const files = await window.electronAPI.listMediaFiles();
  const list = document.getElementById("mediaList");
  list.innerHTML = "";

  files.forEach((name) => {
    const li = document.createElement("li");
    li.innerText = name;
    li.style.cursor = "pointer";

    li.onclick = async () => {
      const fullPath = await window.electronAPI.getMediaPath(name);
      player.src = fullPath;
      resetEditorForNewLesson(name);
    };

    list.appendChild(li);
  });
}

async function refreshLessonList() {
  const files = await window.electronAPI.listLessonFiles();
  const list = document.getElementById("lessonList");
  list.innerHTML = "";

  files.forEach((name) => {
    const li = document.createElement("li");
    li.innerText = name;
    li.style.cursor = "pointer";

    li.onclick = async () => {
      const data = await window.electronAPI.readLessonFile(name);
      loadLessonToEditor(data);

      if (lesson.media) {
        const fullPath = await window.electronAPI.getMediaPath(lesson.media);
        player.src = fullPath;
      }
    };

    list.appendChild(li);
  });
}

// ---------- import buttons ----------
document.getElementById("importMediaBtn").onclick = async () => {
  const filename = await window.electronAPI.importMediaFile();
  if (filename) {
    await refreshMediaList();
    alert(`已匯入 media:\n${filename}`);
  }
};

document.getElementById("importLessonBtn").onclick = async () => {
  const filename = await window.electronAPI.importLessonFile();
  if (filename) {
    await refreshLessonList();
    alert(`已匯入 lesson:\n${filename}`);
  }
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

// ---------- add clip ----------
document.getElementById("addClip").onclick = () => {
  syncStartEndFromInputs();

  const jp = document.getElementById("jpText").value.trim();
  const zh = document.getElementById("zhText").value.trim();
  const category = document.getElementById("category").value.trim();

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

  lesson.title = document.getElementById("lessonTitle").value.trim();

  lesson.clips.push({
    start: startTime,
    end: endTime,
    jp,
    zh,
    category
  });

  renderClips();

  document.getElementById("jpText").value = "";
  document.getElementById("zhText").value = "";
  document.getElementById("category").value = "";
};

// ---------- save lesson ----------
document.getElementById("saveLesson").onclick = async () => {
  const title = document.getElementById("lessonTitle").value.trim();

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

  const savedPath = await window.electronAPI.saveLessonFile(lesson);
  alert(`Saved:\n${savedPath}`);
  await refreshLessonList();
};

// ---------- render clips ----------
function renderClips() {
  const list = document.getElementById("clipList");
  list.innerHTML = "";

  lesson.clips.forEach((clip, i) => {
    const li = document.createElement("li");
    li.style.marginBottom = "12px";
    li.style.padding = "8px";
    li.style.border = "1px solid #ccc";
    li.style.borderRadius = "6px";

    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.step = "0.1";
    startInput.value = Number(clip.start || 0).toFixed(1);
    startInput.style.width = "80px";

    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.step = "0.1";
    endInput.value = Number(clip.end || 0).toFixed(1);
    endInput.style.width = "80px";

    const jpInput = document.createElement("input");
    jpInput.type = "text";
    jpInput.value = clip.jp || "";
    jpInput.placeholder = "Japanese sentence";
    jpInput.style.width = "260px";

    const zhInput = document.createElement("input");
    zhInput.type = "text";
    zhInput.value = clip.zh || "";
    zhInput.placeholder = "Chinese translation";
    zhInput.style.width = "220px";

    const categoryInput = document.createElement("input");
    categoryInput.type = "text";
    categoryInput.value = clip.category || "";
    categoryInput.placeholder = "Category";
    categoryInput.style.width = "140px";

    const playBtn = document.createElement("button");
    playBtn.innerText = "Play";
    playBtn.onclick = () => {
      const previewClip = {
        start: parseTimeInput(startInput.value),
        end: parseTimeInput(endInput.value),
        jp: jpInput.value.trim(),
        zh: zhInput.value.trim(),
        category: categoryInput.value.trim()
      };

      if (previewClip.end <= previewClip.start) {
        alert("End time 必須大於 Start time");
        return;
      }

      playClip(previewClip);
    };

    const saveBtn = document.createElement("button");
    saveBtn.innerText = "Save";
    saveBtn.onclick = () => {
      const newStart = parseTimeInput(startInput.value);
      const newEnd = parseTimeInput(endInput.value);

      if (newEnd <= newStart) {
        alert("End time 必須大於 Start time");
        return;
      }

      const newJp = jpInput.value.trim();
      if (!newJp) {
        alert("請輸入日文句子");
        return;
      }

      lesson.clips[i] = {
        start: newStart,
        end: newEnd,
        jp: newJp,
        zh: zhInput.value.trim(),
        category: categoryInput.value.trim()
      };

      renderClips();
    };

    const delBtn = document.createElement("button");
    delBtn.innerText = "Delete";
    delBtn.onclick = () => {
      const ok = confirm(`確定要刪除第 ${i + 1} 個 clip 嗎？`);
      if (!ok) return;

      lesson.clips.splice(i, 1);
      renderClips();
    };

    const goStartText = document.createElement("span");
    goStartText.innerText = "Start";
    goStartText.style.cursor = "pointer";
    goStartText.style.textDecoration = "underline";
    goStartText.onclick = () => {
      seekPlayer(parseTimeInput(startInput.value));
    };

    const goEndText = document.createElement("span");
    goEndText.innerText = "End";
    goEndText.style.cursor = "pointer";
    goEndText.style.textDecoration = "underline";
    goEndText.onclick = () => {
      seekPlayer(parseTimeInput(endInput.value));
    };

    const row1 = document.createElement("div");
    row1.style.display = "flex";
    row1.style.gap = "8px";
    row1.style.alignItems = "center";
    row1.style.flexWrap = "wrap";
    row1.style.marginBottom = "8px";

    row1.append(goStartText, startInput);
    row1.append(goEndText, endInput);
    row1.append(playBtn, saveBtn, delBtn);

    const row2 = document.createElement("div");
    row2.style.display = "flex";
    row2.style.gap = "8px";
    row2.style.alignItems = "center";
    row2.style.flexWrap = "wrap";

    const jpLabel = document.createElement("span");
    jpLabel.innerText = "JP:";

    const zhLabel = document.createElement("span");
    zhLabel.innerText = "ZH:";

    const catLabel = document.createElement("span");
    catLabel.innerText = "Cat:";

    row2.append(jpLabel, jpInput, zhLabel, zhInput, catLabel, categoryInput);

    li.appendChild(row1);
    li.appendChild(row2);

    list.appendChild(li);
  });
}

// ---------- playback ----------
function playClip(clip) {
  stopCurrentClipPlayback();
  player.currentTime = clip.start;
  player.play();

  currentPlayInterval = setInterval(() => {
    if (player.currentTime >= clip.end || player.ended) {
      player.pause();
      stopCurrentClipPlayback();
    }
  }, 50);
}

player.addEventListener("pause", stopCurrentClipPlayback);
player.addEventListener("ended", stopCurrentClipPlayback);

initLibrary();