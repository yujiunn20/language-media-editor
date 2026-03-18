const player = document.getElementById("player");

const lesson = {
  id: null,
  title: "",
  media: "",
  clips: []
};

let startTime = 0;
let endTime = 0;
let currentPlayInterval = null;
let editingClipIndex = -1;
let currentMediaFolderId = null;
let currentLessonFolderId = null;
let moveTargetFolderId = null;

// ---------- helpers ----------
function getStartInput() {
  return document.getElementById("startTime");
}

function getEndInput() {
  return document.getElementById("endTime");
}

async function fetchFolders(kind) {
  const res = await fetch(`/api/folders?kind=${encodeURIComponent(kind)}`);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Load folders failed");
  }

  return data.folders || [];
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

  const flattened = buildFolderTree(folders);

  flattened.forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.innerText = `${"　".repeat(folder.depth)}${folder.name}`;

    if (selectedId != null && Number(selectedId) === folder.id) {
      option.selected = true;
    }

    selectEl.appendChild(option);
  });
}

function getDescendantFolderIds(folders, folderId) {
  const byParent = new Map();

  folders.forEach((folder) => {
    const key = folder.parent_id ?? null;
    if (!byParent.has(key)) {
      byParent.set(key, []);
    }
    byParent.get(key).push(folder);
  });

  const result = [];
  const stack = [...(byParent.get(folderId) || [])];

  while (stack.length > 0) {
    const current = stack.pop();
    result.push(current.id);

    const children = byParent.get(current.id) || [];
    stack.push(...children);
  }

  return result;
}

function openMoveModal(folders, options = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById("moveModal");
    const list = document.getElementById("moveFolderList");
    const {
      excludedFolderIds = [],
      initialFolderId = undefined
    } = options;

    list.innerHTML = "";
    moveTargetFolderId = initialFolderId;

    const flattened = buildFolderTree(folders);
    const selectableNodes = [];

    const rootDiv = document.createElement("div");
    rootDiv.innerText = "(root)";
    rootDiv.onclick = () => {
      selectFolder(null, rootDiv);
    };
    list.appendChild(rootDiv);
    selectableNodes.push(rootDiv);

    flattened.forEach((folder) => {
      if (excludedFolderIds.includes(folder.id)) return;

      const div = document.createElement("div");
      div.innerText = `${"　".repeat(folder.depth)}${folder.name}`;
      div.onclick = () => {
        selectFolder(folder.id, div);
      };

      list.appendChild(div);
      selectableNodes.push(div);
    });

    function selectFolder(id, el) {
      moveTargetFolderId = id;
      selectableNodes.forEach((node) => node.classList.remove("folder-selected"));
      el.classList.add("folder-selected");
    }

    document.getElementById("moveConfirmBtn").onclick = () => {
      const selectedId = moveTargetFolderId;
      close();
      resolve(selectedId);
    };
    
    document.getElementById("moveCancelBtn").onclick = () => {
      close();
      resolve(undefined);
    };

    function close() {
      modal.classList.add("hidden");
      moveTargetFolderId = null;
    }

    modal.classList.remove("hidden");
  });
}

async function refreshFolderSelectors() {
  const mediaFolders = await fetchFolders("media");
  const lessonFolders = await fetchFolders("lesson");

  renderFolderSelect(
    document.getElementById("mediaFolderSelect"),
    mediaFolders,
    currentMediaFolderId
  );

  renderFolderSelect(
    document.getElementById("lessonFolderSelect"),
    lessonFolders,
    currentLessonFolderId
  );
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
  lesson.id = null;
  lesson.title = "";
  lesson.media = selectedMediaName;
  lesson.clips = [];

  getLessonTitleInput().value = "";
  exitEditMode(true);
  renderClips();
}

function loadLessonToEditor(data) {
  lesson.id = data.id; // 🔥 這行很重要
  lesson.title = data.title || "";
  lesson.media = data.media_filename || "";
  lesson.clips = Array.isArray(data.clips) ? data.clips : [];

  getLessonTitleInput().value = lesson.title;
  exitEditMode(true);
  renderClips();
}

// ---------- library ----------
async function initLibrary() {
  document.getElementById("mediaFolderLabel").innerText = "data/media";
  document.getElementById("lessonsFolderLabel").innerText = "data/lessons";

  await refreshFolderSelectors();
  await refreshMediaList();
  await refreshLessonList();
  syncInputsFromStartEnd();
  setEditorMode(false);
}

async function refreshMediaList() {
  const query = currentMediaFolderId != null
    ? `?folder_id=${currentMediaFolderId}`
    : "";

  const res = await fetch(`/api/media${query}`);
  const data = await res.json();

  const list = document.getElementById("mediaList");
  list.innerHTML = "";

  const items = data.media || [];

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "clip-card";

    const nameDiv = document.createElement("div");
    nameDiv.innerText = item.display_name || item.filename;
    nameDiv.style.cursor = "pointer";
    nameDiv.onclick = () => {
      player.src = `/media/${encodeURIComponent(item.filename)}`;
      resetEditorForNewLesson(item.filename);
    };

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const deleteBtn = document.createElement("button");
    deleteBtn.innerText = "Delete";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();

      const ok = confirm(`確定要刪除 media 嗎？\n${item.filename}`);
      if (!ok) return;

      try {
        const res = await fetch(`/api/media/${encodeURIComponent(item.filename)}`, {
          method: "DELETE"
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
          throw new Error(result.error || "Delete failed");
        }

        if (lesson.media === item.filename) {
          player.removeAttribute("src");
          player.load();
          resetEditorForNewLesson("");
        }

        await refreshMediaList();
        alert(`已刪除 media:\n${item.filename}`);
      } catch (err) {
        console.error(err);
        alert(`刪除失敗：\n${err.message || err}`);
      }
    };

    const renameBtn = document.createElement("button");
    renameBtn.innerText = "Rename";

    renameBtn.onclick = async (e) => {
      e.stopPropagation();
    
      const newName = prompt("輸入新的名稱", item.display_name || item.filename);
      if (!newName) return;
    
      try {
        const res = await fetch(`/api/media/${encodeURIComponent(item.filename)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: newName })
        });
      
        const result = await res.json();
      
        if (!res.ok || !result.ok) {
          throw new Error(result.error || "Rename failed");
        }
      
        await refreshMediaList();
      } catch (err) {
        alert(`改名失敗：\n${err.message}`);
      }
    };

    const moveBtn = document.createElement("button");
    moveBtn.innerText = "Move";

    moveBtn.onclick = async (e) => {
      e.stopPropagation();
    
      try {
        const folders = await fetchFolders("media");
      
        const folderId = await openMoveModal(folders);
        if (folderId === undefined) return; // 只有取消才 return
      
        const res = await fetch(`/api/media/${encodeURIComponent(item.filename)}/move`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            folder_id: folderId
          })
        });
      
        const data = await res.json();
      
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Move failed");
        }
      
        await refreshMediaList();
      } catch (err) {
        alert(`移動 media 失敗：\n${err.message}`);
      }
    };

    actions.appendChild(renameBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(deleteBtn);    
    li.append(nameDiv, actions);
    list.appendChild(li);
  });
}

async function refreshLessonList() {
  const query = currentLessonFolderId != null
    ? `?folder_id=${currentLessonFolderId}`
    : "";

  const res = await fetch(`/api/lessons${query}`);
  const lessons = await res.json();

  const list = document.getElementById("lessonList");
  list.innerHTML = "";

  lessons.forEach((lessonItem) => {
    const li = document.createElement("li");
    li.className = "clip-card";

    const nameDiv = document.createElement("div");
    nameDiv.innerText = lessonItem.title;
    nameDiv.style.cursor = "pointer";

    nameDiv.onclick = async () => {
      const res = await fetch(`/api/lessons/${lessonItem.id}`);
      const lessonData = await res.json();

      loadLessonToEditor(lessonData);

      if (lessonData.media_filename) {
        player.src = `/media/${encodeURIComponent(lessonData.media_filename)}`;
      }
    };

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const deleteBtn = document.createElement("button");
    deleteBtn.innerText = "Delete";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();

      const ok = confirm(`確定要刪除 lesson 嗎？\n${lessonItem.title}`);
      if (!ok) return;

      try {
        const res = await fetch(`/api/lessons/${lessonItem.id}`, {
          method: "DELETE"
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
          throw new Error(result.error || "Delete failed");
        }

        if (lesson.id === lessonItem.id) {
          lesson.id = undefined;
          lesson.title = "";
          lesson.media = "";
          lesson.clips = [];
          getLessonTitleInput().value = "";
          exitEditMode(true);
          renderClips();
          player.removeAttribute("src");
          player.load();
        }

        await refreshLessonList();
        alert(`已刪除 lesson:\n${lessonItem.title}`);
      } catch (err) {
        console.error(err);
        alert(`刪除失敗：\n${err.message || err}`);
      }
    };

    const renameBtn = document.createElement("button");
    renameBtn.innerText = "Rename";

    renameBtn.onclick = async (e) => {
      e.stopPropagation();
    
      const newName = prompt("輸入新的 lesson 名稱", lessonItem.title);
      if (!newName) return;
    
      try {
        const res = await fetch(`/api/lessons/${lessonItem.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ title: newName })
        });
      
        const result = await res.json();
      
        if (!res.ok || !result.ok) {
          throw new Error(result.error || "Rename failed");
        }
      
        await refreshLessonList();
      
        // 👉 如果正在編輯這個 lesson，也同步更新
        if (lesson.id === lessonItem.id) {
          lesson.title = result.title;
          getLessonTitleInput().value = result.title;
        }
      
      } catch (err) {
        alert(`改名失敗：\n${err.message}`);
      }
    };

    const moveBtn = document.createElement("button");
    moveBtn.innerText = "Move";

    moveBtn.onclick = async (e) => {
      e.stopPropagation();
    
      try {
        const folders = await fetchFolders("lesson");
      
        const folderId = await openMoveModal(folders);
        if (folderId === undefined) return; // 只有取消才 return
      
        const res = await fetch(`/api/lessons/${lessonItem.id}/move`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            folder_id: folderId
          })
        });
      
        const data = await res.json();
      
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Move failed");
        }
      
        await refreshLessonList();
      } catch (err) {
        alert(`移動 lesson 失敗：\n${err.message}`);
      }
    };

    actions.appendChild(renameBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(deleteBtn);

    li.append(nameDiv, actions);
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

    if (currentMediaFolderId != null) {
      form.append("folder_id", currentMediaFolderId);
    }

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
      
    if (currentLessonFolderId != null) {
      form.append("folder_id", currentLessonFolderId);
    }

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
    alert(`已匯入 lesson:\n${data.title} (id: ${data.id})`);
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

// ---------- folders control ----------
document.getElementById("mediaFolderSelect").addEventListener("change", async (e) => {
  currentMediaFolderId = e.target.value ? Number(e.target.value) : null;
  await refreshMediaList();
});

document.getElementById("lessonFolderSelect").addEventListener("change", async (e) => {
  currentLessonFolderId = e.target.value ? Number(e.target.value) : null;
  await refreshLessonList();
});

document.getElementById("newMediaFolderBtn").onclick = async () => {
  const name = prompt("輸入新的 media 資料夾名稱");
  if (!name) return;

  try {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        kind: "media",
        parent_id: currentMediaFolderId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Create folder failed");
    }

    await refreshFolderSelectors();
    currentMediaFolderId = data.id;
    document.getElementById("mediaFolderSelect").value = String(data.id);
    await refreshMediaList();
  } catch (err) {
    alert(`新增資料夾失敗：\n${err.message}`);
  }
};

document.getElementById("newLessonFolderBtn").onclick = async () => {
  const name = prompt("輸入新的 lesson 資料夾名稱");
  if (!name) return;

  try {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        kind: "lesson",
        parent_id: currentLessonFolderId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Create folder failed");
    }

    await refreshFolderSelectors();
    currentLessonFolderId = data.id;
    document.getElementById("lessonFolderSelect").value = String(data.id);
    await refreshLessonList();
  } catch (err) {
    alert(`新增資料夾失敗：\n${err.message}`);
  }
};

document.getElementById("deleteMediaFolderBtn").onclick = async () => {
  if (currentMediaFolderId == null) {
    alert("現在是 root，不能刪除");
    return;
  }

  const ok = confirm("確定要刪除目前的 media 資料夾嗎？");
  if (!ok) return;

  try {
    const res = await fetch(`/api/folders/${currentMediaFolderId}`, {
      method: "DELETE"
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Delete folder failed");
    }

    currentMediaFolderId = null;
    await refreshFolderSelectors();
    await refreshMediaList();
  } catch (err) {
    alert(`刪除資料夾失敗：\n${err.message}`);
  }
};

document.getElementById("deleteLessonFolderBtn").onclick = async () => {
  if (currentLessonFolderId == null) {
    alert("現在是 root，不能刪除");
    return;
  }

  const ok = confirm("確定要刪除目前的 lesson 資料夾嗎？");
  if (!ok) return;

  try {
    const res = await fetch(`/api/folders/${currentLessonFolderId}`, {
      method: "DELETE"
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Delete folder failed");
    }

    currentLessonFolderId = null;
    await refreshFolderSelectors();
    await refreshLessonList();
  } catch (err) {
    alert(`刪除資料夾失敗：\n${err.message}`);
  }
};

document.getElementById("moveMediaFolderBtn").onclick = async () => {
  if (currentMediaFolderId == null) {
    alert("現在是 root，不能移動 root");
    return;
  }

  try {
    const folders = await fetchFolders("media");
    const excludedFolderIds = [
      currentMediaFolderId,
      ...getDescendantFolderIds(folders, currentMediaFolderId)
    ];

    const parentId = await openMoveModal(folders, {
      excludedFolderIds
    });
    if (parentId === undefined) return;

    const res = await fetch(`/api/folders/${currentMediaFolderId}/move`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        parent_id: parentId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Move folder failed");
    }

    await refreshFolderSelectors();
    await refreshMediaList();
    alert("media folder 已移動");
  } catch (err) {
    alert(`移動資料夾失敗：\n${err.message}`);
  }
};

document.getElementById("moveLessonFolderBtn").onclick = async () => {
  if (currentLessonFolderId == null) {
    alert("現在是 root，不能移動 root");
    return;
  }

  try {
    const folders = await fetchFolders("lesson");
    const excludedFolderIds = [
      currentLessonFolderId,
      ...getDescendantFolderIds(folders, currentLessonFolderId)
    ];

    const parentId = await openMoveModal(folders, {
      excludedFolderIds
    });
    if (parentId === undefined) return;

    const res = await fetch(`/api/folders/${currentLessonFolderId}/move`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        parent_id: parentId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Move folder failed");
    }

    await refreshFolderSelectors();
    await refreshLessonList();
    alert("lesson folder 已移動");
  } catch (err) {
    alert(`移動資料夾失敗：\n${err.message}`);
  }
};

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
      body: JSON.stringify({
        ...lesson,
        folder_id: currentLessonFolderId
      })
    });

    const data = await res.json();

    if (!res.ok || (!data.ok && !data.success)) {
      throw new Error(data.error || "Save failed");
    }

    lesson.id = data.id;

    alert(`Saved:\n${data.filename || data.id || ""}`);
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