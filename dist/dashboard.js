import { createComponent as _$createComponent } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Index, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
import { labels, workflowTreeRows } from '../src/dag_run/panel-model.js';
const marks = {
  pending: '○',
  running: '◐',
  done: '✓',
  failed: '×',
  unverified: '?',
  blocked: '–',
  paused: '–',
  cancelled: '–'
};
export function Dashboard(props) {
  const api = props.api;
  const theme = () => api.theme.current;
  const [selected, setSelected] = createSignal(Math.max(0, props.view()?.tasks?.findIndex(task => task.id === props.focusTask) ?? 0));
  const [now, setNow] = createSignal(Date.now());
  const observedAt = Date.now();
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const view = () => props.view();
  const workflow = () => view()?.workflow;
  const tasks = () => view()?.tasks ?? [];
  const done = () => tasks().filter(t => t.status === 'done').length;
  const percent = () => tasks().length ? Math.round(done() * 100 / tasks().length) : 0;
  const running = () => view()?.status === 'running';
  const status = () => workflow() && view()?.status === 'paused' ? '已暂停' : labels[view()?.status] ?? view()?.status ?? '未运行';
  const color = state => state === 'done' ? theme().success : state === 'running' ? theme().primary : state === 'unverified' || state === 'paused' ? theme().warning ?? theme().textMuted : ['failed', 'blocked', 'cancelled', '启动失败'].includes(state) ? theme().error : theme().textMuted;
  const elapsed = () => {
    const seconds = Math.floor(((running() ? now() : view()?.updatedAt ?? observedAt) - (view()?.startedAt ?? observedAt)) / 1000);
    return seconds < 60 ? `${Math.max(0, seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const [collapsed, setCollapsed] = createSignal(new Set());
  const [treeSelection, selectTree] = createSignal();
  const treeRows = createMemo(() => workflowTreeRows(view(), collapsed()));
  const visibleSelection = createMemo(() => {
    const rows = treeRows();
    return rows.find(row => row.key === treeSelection()) ?? rows.find(row => props.focusSession && row.task?.session === props.focusSession) ?? rows.find(row => row.type === 'plan' && row.status === 'running') ?? rows.findLast(row => row.type === 'round') ?? rows[0];
  });
  const treeIndex = createMemo(() => treeRows().findIndex(row => row.key === visibleSelection()?.key));
  let treeScroll, scrollTimer;
  function reveal(index) {
    if (!treeScroll || index < 0) return;
    const top = treeScroll.scrollTop ?? 0;
    const height = treeScroll.viewport?.height ?? treeScroll.height;
    if (index < top) treeScroll.scrollTop = index;else if (height > 0 && index >= top + height) treeScroll.scrollTop = index - height + 1;
  }
  createEffect(() => {
    const index = treeIndex();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => reveal(index), 0);
  });
  onCleanup(() => clearTimeout(scrollTimer));
  function fold(row, close) {
    if (!row?.branch) return;
    selectTree(row.key);
    setCollapsed(previous => {
      const next = new Set(previous);
      if (close) next.add(row.key);else next.delete(row.key);
      return next;
    });
  }
  function activate(row) {
    if (!row) return;
    if (row.branch) fold(row, row.expanded);else if (row.task) props.open(row.task);
  }
  function move(delta) {
    if (!workflow()) {
      setSelected(i => Math.max(0, Math.min(tasks().length - 1, i + delta)));
      return;
    }
    const rows = treeRows();
    const row = rows[Math.max(0, Math.min(rows.length - 1, treeIndex() + delta))];
    if (row) selectTree(row.key);
  }
  const open = () => workflow() ? activate(visibleSelection()) : props.open(tasks()[selected()]);
  const unregister = api.keymap.registerLayer({
    get enabled() {
      return api.route.current.name === 'static-dag.dashboard';
    },
    commands: [{
      name: 'static-dag.page.up',
      run() {
        move(-1);
      }
    }, {
      name: 'static-dag.page.down',
      run() {
        move(1);
      }
    }, {
      name: 'static-dag.page.left',
      run() {
        const row = visibleSelection();
        if (row?.expanded) fold(row, true);else if (row?.parent) selectTree(row.parent);
      }
    }, {
      name: 'static-dag.page.right',
      run() {
        const row = visibleSelection();
        if (row?.branch && !row.expanded) fold(row, false);else if (row?.expanded) move(1);
      }
    }, {
      name: 'static-dag.page.open',
      run: open
    }, {
      name: 'static-dag.page.back',
      run: props.back
    }, {
      name: 'static-dag.page.refresh',
      run: props.refresh
    }, {
      name: 'static-dag.page.cancel',
      run() {
        if (running()) props.cancel();
      }
    }],
    bindings: [{
      key: 'up',
      cmd: 'static-dag.page.up'
    }, {
      key: 'down',
      cmd: 'static-dag.page.down'
    }, {
      key: 'left',
      cmd: 'static-dag.page.left'
    }, {
      key: 'right',
      cmd: 'static-dag.page.right'
    }, {
      key: 'enter',
      cmd: 'static-dag.page.open'
    }, {
      key: 'escape',
      cmd: 'static-dag.page.back'
    }, {
      key: 'r',
      cmd: 'static-dag.page.refresh'
    }, {
      key: 'c',
      cmd: 'static-dag.page.cancel'
    }]
  });
  if (typeof unregister === 'function') onCleanup(unregister);
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("b"),
      _el$5 = _$createElement("text"),
      _el$6 = _$createElement("text"),
      _el$10 = _$createElement("box"),
      _el$11 = _$createElement("text"),
      _el$12 = _$createElement("text"),
      _el$13 = _$createTextNode(`r 刷新`);
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$6);
    _$insertNode(_el$, _el$10);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "height", "100%");
    _$setProp(_el$, "padding", 2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "gap", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$insertNode(_el$3, _el$4);
    _$insert(_el$4, () => workflow() ? '一多适配' : 'DAG 任务看板');
    _$insert(_el$5, status, null);
    _$insert(_el$5, (() => {
      var _c$ = _$memo(() => !!workflow());
      return () => _c$() ? ` · ${elapsed()}` : '';
    })(), null);
    _$setProp(_el$6, "truncate", true);
    _$insert(_el$6, () => view()?.root ?? props.root());
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return workflow();
      },
      get fallback() {
        return [_$createComponent(Show, {
          get when() {
            return view()?.gitea?.repo;
          },
          get children() {
            var _el$16 = _$createElement("text"),
              _el$17 = _$createTextNode(`本轮仓库：`),
              _el$18 = _$createTextNode(`/`);
            _$insertNode(_el$16, _el$17);
            _$insertNode(_el$16, _el$18);
            _$setProp(_el$16, "truncate", true);
            _$insert(_el$16, () => view()?.gitea?.owner, _el$18);
            _$insert(_el$16, () => view()?.gitea?.repo, null);
            _$effect(_$p => _$setProp(_el$16, "fg", theme().textMuted, _$p));
            return _el$16;
          }
        }), _$createComponent(Show, {
          get when() {
            return view()?.ux;
          },
          get children() {
            var _el$19 = _$createElement("text"),
              _el$20 = _$createTextNode(`UX 未验证 · `),
              _el$21 = _$createTextNode(` · 代码完成不代表 UX 通过`);
            _$insertNode(_el$19, _el$20);
            _$insertNode(_el$19, _el$21);
            _$insert(_el$19, () => view()?.ux?.reason === 'no-device' ? '未提供设备' : '设备证据未核验', _el$21);
            _$effect(_$p => _$setProp(_el$19, "fg", theme().textMuted, _$p));
            return _el$19;
          }
        }), (() => {
          var _el$22 = _$createElement("box"),
            _el$23 = _$createElement("box"),
            _el$24 = _$createElement("text"),
            _el$25 = _$createTextNode(` / `),
            _el$26 = _$createTextNode(` 个任务已完成 · 执行中 `),
            _el$27 = _$createTextNode(` · 并发上限 `),
            _el$28 = _$createElement("text"),
            _el$29 = _$createElement("text"),
            _el$30 = _$createElement("span"),
            _el$31 = _$createTextNode(` `),
            _el$32 = _$createTextNode(`%`),
            _el$33 = _$createElement("text");
          _$insertNode(_el$22, _el$23);
          _$insertNode(_el$22, _el$29);
          _$insertNode(_el$22, _el$33);
          _$setProp(_el$22, "padding", 1);
          _$setProp(_el$22, "flexDirection", "column");
          _$setProp(_el$22, "gap", 1);
          _$insertNode(_el$23, _el$24);
          _$insertNode(_el$23, _el$28);
          _$setProp(_el$23, "flexDirection", "row");
          _$setProp(_el$23, "justifyContent", "space-between");
          _$insertNode(_el$24, _el$25);
          _$insertNode(_el$24, _el$26);
          _$insertNode(_el$24, _el$27);
          _$insert(_el$24, done, _el$25);
          _$insert(_el$24, () => tasks().length, _el$26);
          _$insert(_el$24, () => tasks().filter(task => task.status === 'running').length, _el$27);
          _$insert(_el$24, () => view()?.maxConcurrency ?? 1, null);
          _$insert(_el$28, elapsed);
          _$insertNode(_el$29, _el$30);
          _$insertNode(_el$29, _el$31);
          _$insertNode(_el$29, _el$32);
          _$insert(_el$29, () => '━'.repeat(Math.round(percent() / 5)), _el$30);
          _$insert(_el$30, () => '─'.repeat(20 - Math.round(percent() / 5)));
          _$insert(_el$29, percent, _el$32);
          _$setProp(_el$33, "wrapMode", "word");
          _$insert(_el$33, () => view()?.detail ?? '使用 /dag_run 启动当前工作区的 DAG。');
          _$effect(_p$ => {
            var _v$7 = theme().backgroundPanel,
              _v$8 = theme().text,
              _v$9 = theme().textMuted,
              _v$0 = theme().primary,
              _v$1 = theme().textMuted,
              _v$10 = view()?.status === '启动失败' ? theme().error : theme().textMuted;
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$22, "backgroundColor", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$24, "fg", _v$8, _p$.t));
            _v$9 !== _p$.a && (_p$.a = _$setProp(_el$28, "fg", _v$9, _p$.a));
            _v$0 !== _p$.o && (_p$.o = _$setProp(_el$29, "fg", _v$0, _p$.o));
            _v$1 !== _p$.i && (_p$.i = _$setProp(_el$30, "fg", _v$1, _p$.i));
            _v$10 !== _p$.n && (_p$.n = _$setProp(_el$33, "fg", _v$10, _p$.n));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined,
            n: undefined
          });
          return _el$22;
        })(), (() => {
          var _el$34 = _$createElement("box"),
            _el$35 = _$createElement("text"),
            _el$37 = _$createElement("text"),
            _el$39 = _$createElement("text"),
            _el$41 = _$createElement("text"),
            _el$43 = _$createElement("text");
          _$insertNode(_el$34, _el$35);
          _$insertNode(_el$34, _el$37);
          _$insertNode(_el$34, _el$39);
          _$insertNode(_el$34, _el$41);
          _$insertNode(_el$34, _el$43);
          _$setProp(_el$34, "flexDirection", "row");
          _$setProp(_el$34, "paddingLeft", 1);
          _$setProp(_el$34, "paddingRight", 1);
          _$setProp(_el$34, "gap", 2);
          _$insertNode(_el$35, _$createTextNode(`编号`));
          _$setProp(_el$35, "width", 4);
          _$insertNode(_el$37, _$createTextNode(`任务`));
          _$setProp(_el$37, "flexGrow", 1);
          _$insertNode(_el$39, _$createTextNode(`状态`));
          _$setProp(_el$39, "width", 10);
          _$insertNode(_el$41, _$createTextNode(`前置依赖`));
          _$setProp(_el$41, "width", 12);
          _$insertNode(_el$43, _$createTextNode(`PR`));
          _$setProp(_el$43, "width", 8);
          _$effect(_p$ => {
            var _v$11 = theme().textMuted,
              _v$12 = theme().textMuted,
              _v$13 = theme().textMuted,
              _v$14 = theme().textMuted,
              _v$15 = theme().textMuted;
            _v$11 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$11, _p$.e));
            _v$12 !== _p$.t && (_p$.t = _$setProp(_el$37, "fg", _v$12, _p$.t));
            _v$13 !== _p$.a && (_p$.a = _$setProp(_el$39, "fg", _v$13, _p$.a));
            _v$14 !== _p$.o && (_p$.o = _$setProp(_el$41, "fg", _v$14, _p$.o));
            _v$15 !== _p$.i && (_p$.i = _$setProp(_el$43, "fg", _v$15, _p$.i));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined
          });
          return _el$34;
        })(), (() => {
          var _el$45 = _$createElement("scrollbox");
          _$setProp(_el$45, "flexGrow", 1);
          _$insert(_el$45, _$createComponent(For, {
            get each() {
              return tasks();
            },
            children: (task, index) => (() => {
              var _el$49 = _$createElement("box"),
                _el$50 = _$createElement("text"),
                _el$51 = _$createElement("text"),
                _el$52 = _$createElement("text"),
                _el$53 = _$createElement("text"),
                _el$54 = _$createElement("text");
              _$insertNode(_el$49, _el$50);
              _$insertNode(_el$49, _el$51);
              _$insertNode(_el$49, _el$52);
              _$insertNode(_el$49, _el$53);
              _$insertNode(_el$49, _el$54);
              _$setProp(_el$49, "flexDirection", "row");
              _$setProp(_el$49, "gap", 2);
              _$setProp(_el$49, "paddingLeft", 1);
              _$setProp(_el$49, "paddingRight", 1);
              _$setProp(_el$49, "height", 2);
              _$setProp(_el$49, "onMouseUp", () => {
                setSelected(index());
                props.open(task);
              });
              _$setProp(_el$50, "width", 4);
              _$insert(_el$50, () => task.id);
              _$setProp(_el$51, "flexGrow", 1);
              _$setProp(_el$51, "flexShrink", 1);
              _$setProp(_el$51, "truncate", true);
              _$insert(_el$51, () => task.title);
              _$setProp(_el$52, "width", 10);
              _$insert(_el$52, (() => {
                var _c$2 = _$memo(() => !!task.retry?.waiting);
                return () => _c$2() ? '等待重试' : labels[task.status] ?? task.status;
              })());
              _$setProp(_el$53, "width", 12);
              _$insert(_el$53, (() => {
                var _c$3 = _$memo(() => !!task.dependencies.length);
                return () => _c$3() ? task.dependencies.join(', ') : '—';
              })());
              _$setProp(_el$54, "width", 8);
              _$insert(_el$54, (() => {
                var _c$4 = _$memo(() => !!task.pr);
                return () => _c$4() ? '#' + task.pr : '—';
              })());
              _$effect(_p$ => {
                var _v$16 = index() === selected() ? theme().backgroundElement : theme().background,
                  _v$17 = theme().textMuted,
                  _v$18 = theme().text,
                  _v$19 = color(task.status),
                  _v$20 = theme().textMuted,
                  _v$21 = task.pr ? theme().primary : theme().textMuted;
                _v$16 !== _p$.e && (_p$.e = _$setProp(_el$49, "backgroundColor", _v$16, _p$.e));
                _v$17 !== _p$.t && (_p$.t = _$setProp(_el$50, "fg", _v$17, _p$.t));
                _v$18 !== _p$.a && (_p$.a = _$setProp(_el$51, "fg", _v$18, _p$.a));
                _v$19 !== _p$.o && (_p$.o = _$setProp(_el$52, "fg", _v$19, _p$.o));
                _v$20 !== _p$.i && (_p$.i = _$setProp(_el$53, "fg", _v$20, _p$.i));
                _v$21 !== _p$.n && (_p$.n = _$setProp(_el$54, "fg", _v$21, _p$.n));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined
              });
              return _el$49;
            })()
          }), null);
          _$insert(_el$45, _$createComponent(Show, {
            get when() {
              return !tasks().length;
            },
            get children() {
              var _el$46 = _$createElement("text");
              _$insertNode(_el$46, _$createTextNode(`暂无任务`));
              _$effect(_$p => _$setProp(_el$46, "fg", theme().textMuted, _$p));
              return _el$46;
            }
          }), null);
          return _el$45;
        })(), _$createComponent(Show, {
          get when() {
            return tasks()[selected()]?.error;
          },
          get children() {
            var _el$48 = _$createElement("text");
            _$setProp(_el$48, "wrapMode", "word");
            _$insert(_el$48, () => tasks()[selected()]?.error);
            _$effect(_$p => _$setProp(_el$48, "fg", theme().error, _$p));
            return _el$48;
          }
        })];
      },
      get children() {
        return [(() => {
          var _el$7 = _$createElement("text"),
            _el$8 = _$createTextNode(`目标设备：`);
          _$insertNode(_el$7, _el$8);
          _$setProp(_el$7, "truncate", true);
          _$insert(_el$7, () => workflow()?.targets?.join(' · ') || '等待规划确认', null);
          _$effect(_$p => _$setProp(_el$7, "fg", theme().textMuted, _$p));
          return _el$7;
        })(), (() => {
          var _el$9 = _$createElement("scrollbox");
          _$use(element => {
            treeScroll = element;
          }, _el$9);
          _$setProp(_el$9, "flexGrow", 1);
          _$insert(_el$9, _$createComponent(Index, {
            get each() {
              return treeRows();
            },
            children: row => (() => {
              var _el$55 = _$createElement("box"),
                _el$56 = _$createElement("text"),
                _el$57 = _$createElement("text"),
                _el$58 = _$createTextNode(` `),
                _el$59 = _$createElement("text");
              _$insertNode(_el$55, _el$56);
              _$insertNode(_el$55, _el$57);
              _$insertNode(_el$55, _el$59);
              _$setProp(_el$55, "flexDirection", "row");
              _$setProp(_el$55, "height", 1);
              _$setProp(_el$55, "flexShrink", 0);
              _$setProp(_el$55, "paddingLeft", 1);
              _$setProp(_el$55, "paddingRight", 1);
              _$setProp(_el$55, "onMouseUp", () => {
                selectTree(row().key);
                activate(row());
              });
              _$setProp(_el$56, "flexShrink", 0);
              _$insert(_el$56, () => row().prefix, null);
              _$insert(_el$56, (() => {
                var _c$5 = _$memo(() => !!row().branch);
                return () => _c$5() ? row().expanded ? '▾ ' : '▸ ' : '';
              })(), null);
              _$insertNode(_el$57, _el$58);
              _$setProp(_el$57, "flexShrink", 0);
              _$insert(_el$57, () => marks[row().status] ?? '○', _el$58);
              _$setProp(_el$59, "flexGrow", 1);
              _$setProp(_el$59, "flexShrink", 1);
              _$setProp(_el$59, "truncate", true);
              _$insert(_el$59, () => row().label);
              _$insert(_el$55, _$createComponent(Show, {
                get when() {
                  return row().summary;
                },
                get children() {
                  var _el$60 = _$createElement("text");
                  _$setProp(_el$60, "flexShrink", 1);
                  _$setProp(_el$60, "paddingLeft", 1);
                  _$setProp(_el$60, "truncate", true);
                  _$insert(_el$60, () => row().summary);
                  _$effect(_$p => _$setProp(_el$60, "fg", color(row().status), _$p));
                  return _el$60;
                }
              }), null);
              _$effect(_p$ => {
                var _v$22 = visibleSelection()?.key === row().key ? theme().backgroundElement : theme().background,
                  _v$23 = theme().textMuted,
                  _v$24 = color(row().status),
                  _v$25 = theme().text;
                _v$22 !== _p$.e && (_p$.e = _$setProp(_el$55, "backgroundColor", _v$22, _p$.e));
                _v$23 !== _p$.t && (_p$.t = _$setProp(_el$56, "fg", _v$23, _p$.t));
                _v$24 !== _p$.a && (_p$.a = _$setProp(_el$57, "fg", _v$24, _p$.a));
                _v$25 !== _p$.o && (_p$.o = _$setProp(_el$59, "fg", _v$25, _p$.o));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined
              });
              return _el$55;
            })()
          }));
          return _el$9;
        })(), _$createComponent(Show, {
          get when() {
            return view()?.detail;
          },
          get children() {
            var _el$0 = _$createElement("text");
            _$setProp(_el$0, "wrapMode", "word");
            _$insert(_el$0, () => view()?.detail);
            _$effect(_$p => _$setProp(_el$0, "fg", color(view()?.status), _$p));
            return _el$0;
          }
        }), _$createComponent(Show, {
          get when() {
            return visibleSelection()?.task?.error;
          },
          get children() {
            var _el$1 = _$createElement("text");
            _$setProp(_el$1, "wrapMode", "word");
            _$insert(_el$1, () => visibleSelection()?.task.error);
            _$effect(_$p => _$setProp(_el$1, "fg", theme().error, _$p));
            return _el$1;
          }
        })];
      }
    }), _el$10);
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$12);
    _$setProp(_el$10, "flexDirection", "row");
    _$setProp(_el$10, "justifyContent", "space-between");
    _$setProp(_el$11, "truncate", true);
    _$insert(_el$11, () => workflow() ? '↑↓ 选择 · Enter 展开或查看 Agent · Esc 返回' : '↑↓ 选择 · Enter / 点击 查看 Agent · Esc 返回会话');
    _$insertNode(_el$12, _el$13);
    _$insert(_el$12, () => running() ? ' · c 取消运行' : '', null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return !workflow();
      },
      get children() {
        var _el$14 = _$createElement("text");
        _$insertNode(_el$14, _$createTextNode(`Agent 详情中按 ↑ 或点击底部「返回 DAG 看板」回到这里。`));
        _$effect(_$p => _$setProp(_el$14, "fg", theme().textMuted, _$p));
        return _el$14;
      }
    }), null);
    _$effect(_p$ => {
      var _v$ = theme().background,
        _v$2 = theme().text,
        _v$3 = color(view()?.status),
        _v$4 = theme().textMuted,
        _v$5 = theme().textMuted,
        _v$6 = theme().textMuted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$11, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$12, "fg", _v$6, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
    });
    return _el$;
  })();
}
export function DetailReturn(props) {
  createEffect(() => {
    const route = props.api.route.current;
    if (route.name !== 'session') return;
    for (const message of props.api.state.session.messages(route.params.sessionID)) {
      for (const part of props.api.state.part(message.id)) void props.hideTransport(part);
    }
  });
  return _$createComponent(Show, {
    get when() {
      return props.active();
    },
    get children() {
      var _el$61 = _$createElement("box"),
        _el$62 = _$createElement("text"),
        _el$64 = _$createElement("text");
      _$insertNode(_el$61, _el$62);
      _$insertNode(_el$61, _el$64);
      _$setProp(_el$61, "flexDirection", "row");
      _$setProp(_el$61, "paddingLeft", 2);
      _$setProp(_el$61, "paddingRight", 2);
      _$setProp(_el$61, "height", 1);
      _$insertNode(_el$62, _$createTextNode(`↑ 返回 DAG 看板`));
      _$insertNode(_el$64, _$createTextNode(` 按上方向键或点击这里`));
      _$effect(_p$ => {
        var _v$26 = props.api.theme.current.backgroundPanel,
          _v$27 = props.back,
          _v$28 = props.api.theme.current.primary,
          _v$29 = props.api.theme.current.textMuted;
        _v$26 !== _p$.e && (_p$.e = _$setProp(_el$61, "backgroundColor", _v$26, _p$.e));
        _v$27 !== _p$.t && (_p$.t = _$setProp(_el$61, "onMouseUp", _v$27, _p$.t));
        _v$28 !== _p$.a && (_p$.a = _$setProp(_el$62, "fg", _v$28, _p$.a));
        _v$29 !== _p$.o && (_p$.o = _$setProp(_el$64, "fg", _v$29, _p$.o));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined
      });
      return _el$61;
    }
  });
}
