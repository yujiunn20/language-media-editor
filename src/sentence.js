const player = document.getElementById("sentencePlayer");

const sentenceState = {
  q: "",
  category: ""
};

const isEditMode = new URLSearchParams(window.location.search).get("mode") === "edit";
let currentSentenceTimeHandler = null;
let editingSentenceId = null;
let sentenceCurrentPage = 1;
let sentencePageSize = 10;
let sentenceItems = [];
let exportAvailableItems = [];
const selectedExportSentences = new Map();

function parseTimeInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function formatTime(value) {
  return parseTimeInput(value).toFixed(1);
}

function getSentencePageCount(totalSentences = sentenceItems.length) {
  return Math.max(1, Math.ceil(totalSentences / sentencePageSize));
}

function clampSentencePage(totalSentences = sentenceItems.length) {
  sentenceCurrentPage = Math.min(
    Math.max(1, sentenceCurrentPage),
    getSentencePageCount(totalSentences)
  );
}

async function refreshSentenceCategoryOptions() {
  const res = await fetch("/api/sentence-categories");
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Load categories failed");
  }

  const select = document.getElementById("sentenceCategoryFilter");
  const exportSelect = document.getElementById("sentenceExportCategoryFilter");
  const selectedCategory = sentenceState.category;
  const selectedExportCategory = exportSelect.value;
  select.innerHTML = "";
  exportSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.innerText = t("sentence.allCategories");
  select.appendChild(allOption);

  const exportAllOption = document.createElement("option");
  exportAllOption.value = "";
  exportAllOption.innerText = t("sentence.allCategories");
  exportSelect.appendChild(exportAllOption);

  (data.categories || []).forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.innerText = category;
    select.appendChild(option);

    const exportOption = document.createElement("option");
    exportOption.value = category;
    exportOption.innerText = category;
    exportSelect.appendChild(exportOption);
  });

  select.value = selectedCategory;
  exportSelect.value = selectedExportCategory;
}

function openSentenceEditor(item) {
  if (!isEditMode) return;

  editingSentenceId = item.id;

  document.getElementById("sentenceEditorPanel").style.display = "block";
  document.getElementById("editSentenceId").value = item.id;
  document.getElementById("editSentenceJp").value = item.jp || "";
  document.getElementById("editSentenceZh").value = item.zh || "";
  document.getElementById("editSentenceCategory").value = item.category || "";
  document.getElementById("editSentenceNote").value = item.note || "";

  document.getElementById("editSentenceJp").focus();
}

function closeSentenceEditor() {
  editingSentenceId = null;

  document.getElementById("sentenceEditorPanel").style.display = "none";
  document.getElementById("editSentenceId").value = "";
  document.getElementById("editSentenceJp").value = "";
  document.getElementById("editSentenceZh").value = "";
  document.getElementById("editSentenceCategory").value = "";
  document.getElementById("editSentenceNote").value = "";
}

async function refreshSentenceList() {
  const params = new URLSearchParams();

  if (sentenceState.q) {
    params.set("q", sentenceState.q);
  }

  if (sentenceState.category) {
    params.set("category", sentenceState.category);
  }

  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/sentences${query}`);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Load sentences failed");
  }

  sentenceItems = data.items || [];
  renderSentenceList();
}

function renderSentenceList() {
  const list = document.getElementById("sentenceList");
  const pagination = document.getElementById("sentencePagination");

  list.innerHTML = "";

  const totalSentences = sentenceItems.length;
  const pageCount = getSentencePageCount(totalSentences);
  clampSentencePage(totalSentences);

  const pageStart = (sentenceCurrentPage - 1) * sentencePageSize;
  const visibleItems = sentenceItems.slice(pageStart, pageStart + sentencePageSize);

  visibleItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "clip-card";

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText =
      `[${formatTime(item.start)} - ${formatTime(item.end)}]` +
      (item.category ? ` | ${item.category}` : "") +
      (item.media_filename ? ` | ${item.media_filename}` : "") +
      (item.audio_filename ? ` | clipped` : " | no-audio");

    const jpDiv = document.createElement("div");
    jpDiv.className = "clip-jp";
    jpDiv.innerText = item.jp || "";

    const zhDiv = document.createElement("div");
    zhDiv.className = "clip-zh";
    zhDiv.innerText = item.zh || "";

    const noteDiv = document.createElement("div");
    noteDiv.style.marginTop = "6px";
    noteDiv.style.color = "#666";
    noteDiv.innerText = item.note ? `${t("common.note")}: ${item.note}` : "";

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const playBtn = document.createElement("button");
    playBtn.innerText = t("common.play");
    playBtn.onclick = async () => {
      try {
        if (currentSentenceTimeHandler) {
          player.removeEventListener("timeupdate", currentSentenceTimeHandler);
          currentSentenceTimeHandler = null;
        }

        if (item.audio_filename) {
          player.src = `/sentence-audio/${encodeURIComponent(item.audio_filename)}`;
          player.currentTime = 0;
          await player.play();
          return;
        }

        if (!item.media_filename) {
          alert("這筆 sentence 沒有 media_filename");
          return;
        }

        if (parseTimeInput(item.end) <= parseTimeInput(item.start)) {
          alert("這筆 sentence 的時間範圍不合法");
          return;
        }

        player.src = `/media/${encodeURIComponent(item.media_filename)}`;
        player.currentTime = parseTimeInput(item.start);
        await player.play();

        currentSentenceTimeHandler = () => {
          if (player.currentTime >= parseTimeInput(item.end) || player.ended) {
            player.pause();
            if (currentSentenceTimeHandler) {
              player.removeEventListener("timeupdate", currentSentenceTimeHandler);
              currentSentenceTimeHandler = null;
            }
          }
        };

        player.addEventListener("timeupdate", currentSentenceTimeHandler);
      } catch (err) {
        console.error(err);
        alert(`播放失敗：\n${err.message || err}`);
      }
    };

    actions.appendChild(playBtn);

    if (isEditMode) {
      const editBtn = document.createElement("button");
      editBtn.innerText = t("common.edit");
      editBtn.onclick = () => {
        openSentenceEditor(item);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.innerText = t("common.delete");
      deleteBtn.onclick = async () => {
        const ok = confirm(`確定要刪除這筆 sentence 嗎？\n${item.jp || ""}`);
        if (!ok) return;

        try {
          const res = await fetch(`/api/sentences/${item.id}`, {
            method: "DELETE"
          });

          const data = await res.json();

          if (!res.ok || !data.ok) {
            throw new Error(data.error || "Delete sentence failed");
          }

          if (editingSentenceId === item.id) {
            closeSentenceEditor();
          }

          await refreshSentenceList();
        } catch (err) {
          console.error(err);
          alert(`刪除 sentence 失敗：\n${err.message || err}`);
        }
      };

      actions.append(editBtn, deleteBtn);
    }

    li.append(meta, jpDiv, zhDiv, noteDiv, actions);
    list.appendChild(li);
  });

  renderSentencePagination(
    pagination,
    totalSentences,
    pageCount,
    pageStart,
    visibleItems.length
  );
}

function renderSentencePagination(container, totalSentences, pageCount, pageStart, visibleCount) {
  container.innerHTML = "";

  const summary = document.createElement("span");
  summary.className = "clip-page-summary";

  if (totalSentences === 0) {
    summary.innerText = `0 ${t("common.sentences")}`;
  } else {
    summary.innerText =
      `${pageStart + 1}-${pageStart + visibleCount} / ${totalSentences} ${t("common.sentences")}`;
  }

  const controls = document.createElement("div");
  controls.className = "clip-page-controls";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.innerText = t("common.prev");
  prevBtn.disabled = sentenceCurrentPage <= 1;
  prevBtn.onclick = () => {
    sentenceCurrentPage -= 1;
    renderSentenceList();
  };

  const pageLabel = document.createElement("span");
  pageLabel.className = "clip-page-label";
  pageLabel.innerText = `${t("common.page")} ${sentenceCurrentPage} / ${pageCount}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.innerText = t("common.next");
  nextBtn.disabled = sentenceCurrentPage >= pageCount;
  nextBtn.onclick = () => {
    sentenceCurrentPage += 1;
    renderSentenceList();
  };

  controls.append(prevBtn, pageLabel, nextBtn);
  container.append(summary, controls);
}

function renderExportAvailableList() {
  const list = document.getElementById("sentenceExportAvailableList");
  list.innerHTML = "";

  if (exportAvailableItems.length === 0) {
    list.innerText = t("sentence.noFound");
    return;
  }

  exportAvailableItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "export-item";

    const main = document.createElement("div");
    main.className = "export-item-main";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedExportSentences.has(item.id);
    checkbox.onchange = () => {
      if (checkbox.checked) {
        selectedExportSentences.set(item.id, item);
      } else {
        selectedExportSentences.delete(item.id);
      }

      renderExportAvailableList();
      renderExportSelectedList();
    };

    const text = document.createElement("label");
    text.className = "export-item-text";
    text.appendChild(checkbox);

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText =
      `[${formatTime(item.start)} - ${formatTime(item.end)}]` +
      (item.category ? ` | ${item.category}` : "") +
      (item.audio_filename ? " | audio" : " | no-audio");

    const jp = document.createElement("div");
    jp.className = "clip-jp";
    jp.innerText = item.jp || "";

    const zh = document.createElement("div");
    zh.className = "clip-zh";
    zh.innerText = item.zh || "";

    text.append(meta, jp, zh);
    main.append(text);
    row.appendChild(main);
    list.appendChild(row);
  });
}

function renderExportSelectedList() {
  const list = document.getElementById("sentenceExportSelectedList");
  const count = document.getElementById("sentenceExportSelectedCount");
  const selectedItems = Array.from(selectedExportSentences.values());

  count.innerText = t("common.selectedCount", { count: selectedItems.length });
  list.innerHTML = "";

  if (selectedItems.length === 0) {
    list.innerText = t("sentence.noSelected");
    return;
  }

  selectedItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "export-item";

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText =
      `[${formatTime(item.start)} - ${formatTime(item.end)}]` +
      (item.category ? ` | ${item.category}` : "");

    const jp = document.createElement("div");
    jp.className = "clip-jp";
    jp.innerText = item.jp || "";

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.innerText = t("common.remove");
    removeBtn.onclick = () => {
      selectedExportSentences.delete(item.id);
      renderExportAvailableList();
      renderExportSelectedList();
    };

    actions.appendChild(removeBtn);
    row.append(meta, jp, actions);
    list.appendChild(row);
  });
}

async function refreshExportAvailableList() {
  const q = document.getElementById("sentenceExportSearchInput").value.trim();
  const category = document.getElementById("sentenceExportCategoryFilter").value;
  const params = new URLSearchParams();

  if (q) {
    params.set("q", q);
  }

  if (category) {
    params.set("category", category);
  }

  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/sentences${query}`);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Search sentences failed");
  }

  exportAvailableItems = data.items || [];
  renderExportAvailableList();
}

function openSentenceExportModal() {
  document.getElementById("sentenceExportTitle").value = t("app.sentenceTitle");
  document.getElementById("sentenceExportSearchInput").value = "";
  document.getElementById("sentenceExportCategoryFilter").value = "";
  selectedExportSentences.clear();
  exportAvailableItems = [];
  renderExportSelectedList();

  document.getElementById("sentenceExportModal").classList.remove("hidden");
  refreshExportAvailableList().catch((err) => {
    console.error(err);
    alert(`搜尋句子失敗：\n${err.message || err}`);
  });
}

function closeSentenceExportModal() {
  document.getElementById("sentenceExportModal").classList.add("hidden");
}

async function downloadSentenceExportZip() {
  const title = document.getElementById("sentenceExportTitle").value.trim();
  const ids = Array.from(selectedExportSentences.keys());

  if (!title) {
    alert("請輸入 export title");
    return;
  }

  if (ids.length === 0) {
    alert("請至少選一個 sentence");
    return;
  }

  try {
    const res = await fetch("/api/sentences/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        ids
      })
    });

    if (!res.ok) {
      let message = "Export failed";
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        message = res.statusText || message;
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "sentence-export"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeSentenceExportModal();
  } catch (err) {
    console.error(err);
    alert(`匯出失敗：\n${err.message || err}`);
  }
}

function importSentenceExportZip() {
  const mode = confirm(t("msg.replaceDuplicatePrompt"))
    ? "replace"
    : "skip";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("file", file);
    form.append("duplicate_mode", mode);

    try {
      const res = await fetch("/api/sentences/import-export", {
        method: "POST",
        body: form
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Import failed");
      }

      closeSentenceEditor();
      await refreshSentenceCategoryOptions();
      await refreshSentenceList();

      alert(
        `匯入完成\n` +
        `新增：${data.imported}\n` +
        `跳過：${data.skipped}\n` +
        `覆蓋：${data.replaced}`
      );
    } catch (err) {
      console.error(err);
      alert(`匯入失敗：\n${err.message || err}`);
    }
  };

  input.click();
}

document.getElementById("saveSentenceEditBtn").onclick = async () => {
  if (!isEditMode) return;

  const id = Number(document.getElementById("editSentenceId").value);
  const jp = document.getElementById("editSentenceJp").value.trim();
  const zh = document.getElementById("editSentenceZh").value.trim();
  const category = document.getElementById("editSentenceCategory").value.trim();
  const note = document.getElementById("editSentenceNote").value.trim();

  if (!id) {
    alert("沒有正在編輯的 sentence");
    return;
  }

  if (!jp) {
    alert(t("msg.sourceCannotBeEmpty"));
    return;
  }

  try {
    const res = await fetch(`/api/sentences/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jp,
        zh,
        category,
        note
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Update sentence failed");
    }

    closeSentenceEditor();
    await refreshSentenceCategoryOptions();
    await refreshSentenceList();
  } catch (err) {
    console.error(err);
    alert(`更新 sentence 失敗：\n${err.message || err}`);
  }
};

document.getElementById("cancelSentenceEditBtn").onclick = () => {
  closeSentenceEditor();
};

document.getElementById("sentenceSearchBtn").onclick = async () => {
  sentenceState.q = document.getElementById("sentenceSearchInput").value.trim();
  sentenceState.category = document.getElementById("sentenceCategoryFilter").value;
  sentenceCurrentPage = 1;

  try {
    await refreshSentenceList();
  } catch (err) {
    console.error(err);
    alert(`搜尋 sentence 失敗：\n${err.message || err}`);
  }
};

document.getElementById("sentenceCategoryFilter").onchange = () => {
  document.getElementById("sentenceSearchBtn").click();
};

document.getElementById("sentenceClearBtn").onclick = async () => {
  sentenceState.q = "";
  sentenceState.category = "";
  sentenceCurrentPage = 1;

  document.getElementById("sentenceSearchInput").value = "";
  document.getElementById("sentenceCategoryFilter").value = "";

  closeSentenceEditor();

  try {
    await refreshSentenceList();
  } catch (err) {
    console.error(err);
    alert(`重整 sentence 失敗：\n${err.message || err}`);
  }
};

document.getElementById("sentencePageSize").onchange = (event) => {
  sentencePageSize = Number(event.target.value) || 10;
  sentenceCurrentPage = 1;
  renderSentenceList();
};

document.getElementById("openSentenceExportBtn").onclick = openSentenceExportModal;
document.getElementById("sentenceExportCancelBtn").onclick = closeSentenceExportModal;
document.getElementById("sentenceExportSearchBtn").onclick = () => {
  refreshExportAvailableList().catch((err) => {
    console.error(err);
    alert(`搜尋句子失敗：\n${err.message || err}`);
  });
};
document.getElementById("sentenceExportCategoryFilter").onchange = () => {
  document.getElementById("sentenceExportSearchBtn").click();
};
document.getElementById("sentenceExportSearchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    document.getElementById("sentenceExportSearchBtn").click();
  }
});
document.getElementById("sentenceExportDownloadBtn").onclick = downloadSentenceExportZip;
document.getElementById("importSentenceExportBtn").onclick = importSentenceExportZip;
document.getElementById("sentenceEditModeBtn").onclick = () => {
  window.location.href = isEditMode ? "sentence.html" : "sentence.html?mode=edit";
};
document.getElementById("backToViewerBtn").onclick = () => {
  window.location.href = "index.html";
};

if (isEditMode) {
  document.querySelector("title").dataset.i18n = "app.sentenceEditorTitle";
  document.querySelector("h1").dataset.i18n = "app.sentenceEditorTitle";
  document.getElementById("sentenceEditModeBtn").dataset.i18n = "nav.viewerMode";
  document.title = t("app.sentenceEditorTitle");
  document.querySelector("h1").innerText = t("app.sentenceEditorTitle");
  document.getElementById("sentenceEditModeBtn").innerText = t("nav.viewerMode");
}

window.addEventListener("ui-language-change", () => {
  if (isEditMode) {
    document.title = t("app.sentenceEditorTitle");
    document.querySelector("h1").innerText = t("app.sentenceEditorTitle");
    document.getElementById("sentenceEditModeBtn").innerText = t("nav.viewerMode");
  }

  refreshSentenceCategoryOptions().catch(console.error);
  renderSentenceList();
  renderExportAvailableList();
  renderExportSelectedList();
});

refreshSentenceList().catch((err) => {
  console.error(err);
  alert(`${t("msg.sentenceInitFailed")}\n${err.message || err}`);
});

refreshSentenceCategoryOptions().catch((err) => {
  console.error(err);
  alert(`${t("msg.categoryInitFailed")}\n${err.message || err}`);
});
