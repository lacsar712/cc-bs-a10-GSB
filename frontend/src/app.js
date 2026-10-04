import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function statusText(status) {
  if (status === "pending") return "候审";
  if (status === "processing") return "处理中";
  if (status === "done") return "已办结";
  return status || "—";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  view: "main",
  snapshotPage: {
    windowName: "",
    list: [],
    selectedId: null,
    detail: null,
    error: "",
    msg: "",
    loading: false,
  },
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

async function loadSnapshotList() {
  const page = state.snapshotPage;
  try {
    page.list = await api("/api/hoisting-snapshots");
    page.error = "";
  } catch (err) {
    page.error = err.message || "加载快照清单失败";
  }
  m.redraw();
}

async function loadSnapshotDetail(id) {
  const page = state.snapshotPage;
  page.selectedId = id;
  page.detail = null;
  try {
    page.detail = await api(`/api/hoisting-snapshots/${id}`);
    page.error = "";
  } catch (err) {
    page.error = err.message || "加载快照明细失败";
  }
  m.redraw();
}

async function freezeSnapshot() {
  const page = state.snapshotPage;
  page.error = "";
  page.msg = "";
  page.loading = true;
  try {
    const detail = await api("/api/hoisting-snapshots", {
      method: "POST",
      body: JSON.stringify({ window_name: page.windowName }),
    });
    page.msg = `窗口「${detail.window_name}」已冻结，共 ${detail.item_count} 笔在途读数`;
    page.windowName = "";
    await loadSnapshotList();
    await loadSnapshotDetail(detail.id);
  } catch (err) {
    page.error = err.message || "冻结失败";
  } finally {
    page.loading = false;
    m.redraw();
  }
}

function topbar() {
  const isWriter = state.user?.role === "writer";
  return m("div.topbar", [
    m("div", [
      m("h1", "桥梁应变班交台"),
      m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
    ]),
    m("div.topbaractions", [
      state.view === "main"
        ? m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                state.view = "snapshots";
                loadSnapshotList();
              },
            },
            "吊装快照"
          )
        : m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                state.view = "main";
                loadReadings();
              },
            },
            "返回班交台"
          ),
      m("span.userinfo", [
        `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
      ]),
      m(
        "button.secondary",
        {
          type: "button",
          onclick: () => {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            state.token = "";
            state.user = null;
            state.rows = [];
            state.view = "main";
            if (state.timer) clearInterval(state.timer);
            m.redraw();
          },
        },
        "退出"
      ),
    ]),
  ]);
}

function readingsView() {
  const isWriter = state.user?.role === "writer";
  return [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m(
            "form",
            {
              onsubmit: async (e) => {
                e.preventDefault();
                state.error = "";
                state.msg = "";
                state.loading = true;
                try {
                  const data = await api("/api/readings", {
                    method: "POST",
                    body: JSON.stringify({
                      span_code: state.submitForm.span_code,
                      microstrain: parseFloat(state.submitForm.microstrain),
                    }),
                  });
                  state.msg = data.message || "已提交";
                  state.submitForm = { span_code: "", microstrain: "" };
                  await loadReadings();
                } catch (err) {
                  state.error = err.message || "提交失败";
                } finally {
                  state.loading = false;
                  m.redraw();
                }
              },
            },
            [
              m("div.row", [
                m("label", [
                  "跨段编号",
                  m("input", {
                    required: true,
                    placeholder: "例如 跨中S3",
                    value: state.submitForm.span_code,
                    oninput: (e) => {
                      state.submitForm.span_code = e.target.value;
                    },
                  }),
                ]),
                m("label", [
                  "微应变（με）",
                  m("input", {
                    required: true,
                    type: "number",
                    step: "0.1",
                    value: state.submitForm.microstrain,
                    oninput: (e) => {
                      state.submitForm.microstrain = e.target.value;
                    },
                  }),
                ]),
                m(
                  "button",
                  { type: "submit", disabled: state.loading },
                  "提交"
                ),
              ]),
              state.error ? m("p.err", state.error) : null,
              state.msg ? m("p.ok", state.msg) : null,
            ]
          ),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", statusText(r.status)),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
        ),
      ]),
    ]),
  ];
}

function snapshotsView() {
  const page = state.snapshotPage;
  const isWriter = state.user?.role === "writer";

  return [
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "吊装窗口冻结"),
      m(
        "p.sub",
        { style: { marginBottom: "0.75rem" } },
        "填写吊装窗口名后一键冻结：系统把当时仍候审或处理中的跨段微应变读数整体抄入窗口快照，供监理复查。"
      ),
      m(
        "form",
        {
          onsubmit: (e) => {
            e.preventDefault();
            freezeSnapshot();
          },
        },
        [
          m("div.row", [
            m("label", [
              "吊装窗口名",
              m("input", {
                required: true,
                placeholder: "例如 第三跨-上午吊装窗口",
                value: page.windowName,
                disabled: !isWriter,
                oninput: (e) => {
                  page.windowName = e.target.value;
                },
              }),
            ]),
            m(
              "button",
              {
                type: "submit",
                disabled: !isWriter || page.loading,
                title: isWriter ? "" : "观察账号仅可翻看快照，不能冻结",
              },
              page.loading ? "冻结中…" : "一键冻结"
            ),
            m(
              "button.secondary",
              { type: "button", onclick: () => loadSnapshotList() },
              "刷新清单"
            ),
          ]),
          isWriter
            ? null
            : m("p.sub", { style: { margin: "0.5rem 0 0" } }, "观察账号仅可翻看快照，不能执行冻结。"),
          page.error ? m("p.err", page.error) : null,
          page.msg ? m("p.ok", page.msg) : null,
        ]
      ),
    ]),

    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "历史窗口清单"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "快照编号"),
            m("th", "吊装窗口名"),
            m("th", "冻结笔数"),
            m("th", "冻结人"),
            m("th", "冻结时间"),
            m("th", "操作"),
          ]),
        ]),
        m(
          "tbody",
          page.list.length
            ? page.list.map((s) =>
                m(
                  "tr",
                  {
                    key: s.id,
                    class: page.selectedId === s.id ? "selected" : "",
                  },
                  [
                    m("td", s.id),
                    m("td", s.window_name),
                    m("td", `${s.item_count} 笔`),
                    m("td", s.frozen_by),
                    m("td", fmtTime(s.frozen_at)),
                    m(
                      "td",
                      m(
                        "button.secondary",
                        {
                          type: "button",
                          onclick: () => loadSnapshotDetail(s.id),
                        },
                        "查看明细"
                      )
                    ),
                  ]
                )
              )
            : [m("tr", m("td", { colspan: 6 }, "暂无冻结窗口"))]
        ),
      ]),
    ]),

    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "窗口快照明细"),
      page.detail
        ? m("p.sub", [
            `窗口「${page.detail.window_name}」冻结于 ${fmtTime(
              page.detail.frozen_at
            )}，冻结人 ${page.detail.frozen_by}，共 ${
              page.detail.item_count
            } 笔。以下为冻结当时的在途读数副本，不随后续办结变化。`,
          ])
        : m("p.sub", "请在上方历史清单中点「查看明细」。"),
      page.detail
        ? m("table", [
            m("thead", [
              m("tr", [
                m("th", "快照序号"),
                m("th", "原读数编号"),
                m("th", "跨段"),
                m("th", "微应变（με）"),
                m("th", "冻结时状态"),
                m("th", "提交人"),
              ]),
            ]),
            m(
              "tbody",
              page.detail.items.map((it) =>
                m("tr", { key: it.seq }, [
                  m("td", it.seq),
                  m("td", it.reading_id),
                  m("td", it.span_code),
                  m("td", it.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: "tag wait" },
                      statusText(it.status_at_freeze)
                    ),
                  ]),
                  m("td", it.created_by || "—"),
                ])
              )
            ),
          ])
        : null,
    ]),
  ];
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(state.loginForm),
                    });
                    state.token = data.access_token;
                    state.user = { username: data.username, role: data.role };
                    localStorage.setItem(TOKEN_KEY, state.token);
                    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
                    await loadReadings();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "用户名",
                    m("input", {
                      value: state.loginForm.username,
                      oninput: (e) => {
                        state.loginForm.username = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "密码",
                    m("input", {
                      type: "password",
                      value: state.loginForm.password,
                      oninput: (e) => {
                        state.loginForm.password = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    return m("div.wrap", [
      topbar(),
      ...(state.view === "snapshots" ? snapshotsView() : readingsView()),
    ]);
  },
};

export default App;
