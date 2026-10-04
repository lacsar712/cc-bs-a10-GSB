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

function displayStatus(status) {
  if (status === "pending") return "候审";
  if (status === "processing") return "处理中";
  if (status === "done") return "已办结";
  return status;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  page: "readings",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  // 吊装快照专页
  windowName: "",
  snapshots: [],
  snapshotDetail: null,
  hoistError: "",
  hoistMsg: "",
  hoistLoading: false,
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
}

async function loadSnapshots() {
  if (!state.token) return;
  try {
    state.snapshots = await api("/api/hoist-snapshots");
    state.hoistError = "";
  } catch {
    state.hoistError = "加载快照清单失败";
  }
}

async function loadSnapshotDetail(id) {
  try {
    state.snapshotDetail = await api(`/api/hoist-snapshots/${id}`);
    state.hoistError = "";
  } catch (err) {
    state.hoistError = err.message || "加载快照明细失败";
  }
  m.redraw();
}

async function refresh() {
  if (state.page === "hoist") {
    await loadSnapshots();
  } else {
    await loadReadings();
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(refresh, 3000);
}

function switchPage(page) {
  state.page = page;
  state.error = "";
  state.hoistError = "";
  state.hoistMsg = "";
  if (page === "hoist") {
    loadSnapshots().then(() => m.redraw());
  } else {
    loadReadings().then(() => m.redraw());
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.snapshots = [];
  state.snapshotDetail = null;
  state.page = "readings";
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

function topbar(isWriter) {
  return m("div.topbar", [
    m("div", [
      m("h1", "桥梁应变班交台"),
      m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
      m("div.nav", [
        m(
          "button.secondary",
          {
            type: "button",
            class: state.page === "readings" ? "active" : "",
            onclick: () => switchPage("readings"),
          },
          "读数列表"
        ),
        m(
          "button.secondary",
          {
            type: "button",
            class: state.page === "hoist" ? "active" : "",
            onclick: () => switchPage("hoist"),
          },
          "吊装快照"
        ),
      ]),
    ]),
    m("div", [
      `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
      m(
        "button.secondary",
        { type: "button", onclick: logout },
        "退出"
      ),
    ]),
  ]);
}

const HoistPage = {
  view() {
    const isWriter = state.user?.role === "writer";
    const detail = state.snapshotDetail;
    return [
      // 块一：窗口名输入 + 一键冻结
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "冻结窗口快照"),
        m(
          "form",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!isWriter) return;
              state.hoistError = "";
              state.hoistMsg = "";
              state.hoistLoading = true;
              try {
                const data = await api("/api/hoist-snapshots", {
                  method: "POST",
                  body: JSON.stringify({ window_name: state.windowName }),
                });
                state.hoistMsg = data.message || "已冻结";
                state.windowName = "";
                await loadSnapshots();
                await loadSnapshotDetail(data.id);
              } catch (err) {
                state.hoistError = err.message || "冻结失败";
              } finally {
                state.hoistLoading = false;
                m.redraw();
              }
            },
          },
          [
            m("div.row", [
              m("label", [
                "窗口名",
                m("input", {
                  required: true,
                  placeholder: "例如 吊装窗口-早班-01",
                  value: state.windowName,
                  disabled: !isWriter,
                  oninput: (e) => {
                    state.windowName = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                {
                  type: "submit",
                  disabled: !isWriter || state.hoistLoading,
                  title: isWriter ? "" : "观察账号仅可查看快照，不能冻结",
                },
                "一键冻结"
              ),
            ]),
            !isWriter
              ? m("p.sub", { style: { margin: "0.5rem 0 0" } }, "观察账号可翻阅快照，不能执行冻结。")
              : null,
            state.hoistError ? m("p.err", state.hoistError) : null,
            state.hoistMsg ? m("p.ok", state.hoistMsg) : null,
          ]
        ),
      ]),
      // 块二：历史清单
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "历史清单"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "快照号"),
              m("th", "窗口名"),
              m("th", "冻结人"),
              m("th", "冻结时间"),
              m("th", "在途笔数"),
              m("th", "操作"),
            ]),
          ]),
          m(
            "tbody",
            state.snapshots.length
              ? state.snapshots.map((s) =>
                  m("tr", { key: s.id }, [
                    m("td", s.id),
                    m("td", s.window_name),
                    m("td", s.created_by),
                    m("td", fmtTime(s.created_at)),
                    m("td", s.item_count),
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
                  ])
                )
              : [m("tr", m("td", { colspan: 6 }, "暂无快照"))]
          ),
        ]),
      ]),
      // 块三：快照明细
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "快照明细"),
        detail
          ? [
              m(
                "p.sub",
                `快照 #${detail.id} · 窗口「${detail.window_name}」 · 冻结人 ${detail.created_by} · ${fmtTime(detail.created_at)} · 共 ${detail.item_count} 笔（冻结当时在途读数，办结后不回改）`
              ),
              m("table", [
                m("thead", [
                  m("tr", [
                    m("th", "读数编号"),
                    m("th", "跨段"),
                    m("th", "微应变"),
                    m("th", "冻结时状态"),
                    m("th", "提交人"),
                    m("th", "提交时间"),
                  ]),
                ]),
                m(
                  "tbody",
                  detail.items.length
                    ? detail.items.map((it) =>
                        m("tr", { key: it.id }, [
                          m("td", it.reading_id),
                          m("td", it.span_code),
                          m("td", it.microstrain),
                          m("td", [
                            m(
                              "span",
                              { class: verdictClass(null, it.status) },
                              displayStatus(it.status)
                            ),
                          ]),
                          m("td", it.created_by),
                          m("td", fmtTime(it.created_at)),
                        ])
                      )
                    : [m("tr", m("td", { colspan: 6 }, "冻结当时没有在途读数"))]
                ),
              ]),
            ]
          : m("p.sub", "从历史清单选择一条快照查看明细。"),
      ]),
    ];
  },
};

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

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      topbar(isWriter),
      state.page === "hoist"
        ? m(HoistPage)
        : [
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
                          m("td", r.status),
                          m("td", r.created_by),
                        ])
                      )
                    : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
                ),
              ]),
            ]),
          ],
    ]);
  },
};

export default App;
