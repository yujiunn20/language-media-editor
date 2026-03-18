const player = document.getElementById("sentencePlayer");

const sentenceState = {
  q: "",
  category: ""
};

function parseTimeInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function formatTime(value) {
  return parseTimeInput(value).toFixed(1);
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

  const list = document.getElementById("sentenceList");
  list.innerHTML = "";

  const items = data.items || [];

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "clip-card";

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    meta.innerText =
      `[${formatTime(item.start)} - ${formatTime(item.end)}]` +
      (item.category ? ` | ${item.category}` : "") +
      (item.media_filename ? ` | ${item.media_filename}` : "");

    const jpDiv = document.createElement("div");
    jpDiv.className = "clip-jp";
    jpDiv.innerText = item.jp || "";

    const zhDiv = document.createElement("div");
    zhDiv.className = "clip-zh";
    zhDiv.innerText = item.zh || "";

    const noteDiv = document.createElement("div");
    noteDiv.style.marginTop = "6px";
    noteDiv.style.color = "#666";
    noteDiv.innerText = item.note ? `Note: ${item.note}` : "";

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const playBtn = document.createElement("button");
    playBtn.innerText = "Play";
    playBtn.onclick = () => {
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
      player.play();

      const onTimeUpdate = () => {
        if (player.currentTime >= parseTimeInput(item.end) || player.ended) {
          player.pause();
          player.removeEventListener("timeupdate", onTimeUpdate);
        }
      };

      player.addEventListener("timeupdate", onTimeUpdate);
    };

    const editBtn = document.createElement("button");
    editBtn.innerText = "Edit";
    editBtn.onclick = async () => {
      const newJp = prompt("編輯 jp", item.jp || "");
      if (newJp === null) return;

      const newZh = prompt("編輯 zh", item.zh || "");
      if (newZh === null) return;

      const newCategory = prompt("編輯 category", item.category || "");
      if (newCategory === null) return;

      const newNote = prompt("編輯 note", item.note || "");
      if (newNote === null) return;

      try {
        const res = await fetch(`/api/sentences/${item.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            jp: newJp.trim(),
            zh: newZh.trim(),
            category: newCategory.trim(),
            note: newNote.trim()
          })
        });

        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Update sentence failed");
        }

        await refreshSentenceList();
      } catch (err) {
        console.error(err);
        alert(`更新 sentence 失敗：\n${err.message || err}`);
      }
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.innerText = "Delete";
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

        await refreshSentenceList();
      } catch (err) {
        console.error(err);
        alert(`刪除 sentence 失敗：\n${err.message || err}`);
      }
    };

    actions.append(playBtn, editBtn, deleteBtn);
    li.append(meta, jpDiv, zhDiv, noteDiv, actions);
    list.appendChild(li);
  });
}

document.getElementById("sentenceSearchBtn").onclick = async () => {
  sentenceState.q = document.getElementById("sentenceSearchInput").value.trim();
  sentenceState.category = document.getElementById("sentenceCategoryFilter").value.trim();

  try {
    await refreshSentenceList();
  } catch (err) {
    console.error(err);
    alert(`搜尋 sentence 失敗：\n${err.message || err}`);
  }
};

document.getElementById("sentenceClearBtn").onclick = async () => {
  sentenceState.q = "";
  sentenceState.category = "";

  document.getElementById("sentenceSearchInput").value = "";
  document.getElementById("sentenceCategoryFilter").value = "";

  try {
    await refreshSentenceList();
  } catch (err) {
    console.error(err);
    alert(`重整 sentence 失敗：\n${err.message || err}`);
  }
};

refreshSentenceList().catch((err) => {
  console.error(err);
  alert(`初始化 Sentence Book 失敗：\n${err.message || err}`);
});