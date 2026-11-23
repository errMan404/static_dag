import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
import { labels, treeRows } from '../src/dag_run/panel-model.js';
export function Dashboard(props) {
  const api = props.api;
  const theme = () => api.theme.current;
  const first = treeRows(props.view());
  const [selected, setSelected] = createSignal(Math.max(0, first.findIndex(row => row.node.id === props.focusTask), first.findIndex(row => row.kind !== 'header')));
  const [now, setNow] = createSignal(Date.now());
  const observedAt = Date.now();
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const view = () => props.view();
  const tasks = () => view()?.tasks ?? [];
  const rows = createMemo(() => treeRows(view()));
  const keys = createMemo(() => rows().map(row => row.key), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index])
  });
  const blank = {
    key: '',
    kind: 'task',
    prefix: '',
    label: '',
    gap: true,
    node: {
      status: 'pending',
      dependencies: []
    }
  };
  const rowOf = key => rows().find(row => row.key === key) ?? blank;
  const label = state => state === 'revise' ? '需修改' : labels[state] ?? state;
  const glyph = state => state === 'done' ? '●' : state === 'running' ? '◉' : ['failed', 'blocked', 'cancelled', 'revise'].includes(state) ? '✕' : '○';
  const done = () => tasks().filter(t => t.status === 'done').length;
  const percent = () => tasks().length ? Math.round(done() * 100 / tasks().length) : 0;
  const running = () => view()?.status === 'running';
  const status = () => labels[view()?.status] ?? view()?.status ?? '未运行';
  const color = state => state === 'done' ? theme().success : state === 'running' ? theme().primary : state === 'revise' ? theme().warning : ['failed', 'blocked', 'cancelled', '启动失败'].includes(state) ? theme().error : theme().textMuted;
  const elapsed = () => {
    const seconds = Math.floor(((running() ? now() : view()?.updatedAt ?? observedAt) - (view()?.startedAt ?? observedAt)) / 1000);
    return seconds < 60 ? `${Math.max(0, seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const open = () => {
    const row = rows()[selected()];
    if (row && row.kind !== 'header') props.open(row.node);
  };
  const move = by => setSelected(from => {
    for (let i = from + by; i >= 0 && i < rows().length; i += by) if (rows()[i].kind !== 'header') return i;
    return from;
  });
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
      _el$11 = _$createElement("box"),
      _el$12 = _$createElement("box"),
      _el$13 = _$createElement("text"),
      _el$14 = _$createTextNode(` / `),
      _el$15 = _$createTextNode(` 个节点已完成 · 执行中 `),
      _el$16 = _$createElement("text"),
      _el$17 = _$createElement("text"),
      _el$18 = _$createElement("span"),
      _el$19 = _$createTextNode(` `),
      _el$20 = _$createTextNode(`%`),
      _el$21 = _$createElement("text"),
      _el$22 = _$createElement("box"),
      _el$23 = _$createElement("text"),
      _el$25 = _$createElement("text"),
      _el$27 = _$createElement("text"),
      _el$29 = _$createElement("scrollbox"),
      _el$34 = _$createElement("box"),
      _el$35 = _$createElement("text"),
      _el$37 = _$createElement("text"),
      _el$38 = _$createTextNode(`r 刷新`),
      _el$39 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$6);
    _$insertNode(_el$, _el$11);
    _$insertNode(_el$, _el$22);
    _$insertNode(_el$, _el$29);
    _$insertNode(_el$, _el$34);
    _$insertNode(_el$, _el$39);
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
    _$insert(_el$4, () => view()?.pipeline ? '一多适配' : 'DAG 任务看板');
    _$insert(_el$5, status);
    _$setProp(_el$6, "truncate", true);
    _$insert(_el$6, () => view()?.root ?? props.root());
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return view()?.gitea?.repo;
      },
      get children() {
        var _el$7 = _$createElement("text"),
          _el$8 = _$createTextNode(`本轮仓库：`),
          _el$9 = _$createTextNode(`/`);
        _$insertNode(_el$7, _el$8);
        _$insertNode(_el$7, _el$9);
        _$setProp(_el$7, "truncate", true);
        _$insert(_el$7, () => view()?.gitea?.owner, _el$9);
        _$insert(_el$7, () => view()?.gitea?.repo, null);
        _$effect(_$p => _$setProp(_el$7, "fg", theme().textMuted, _$p));
        return _el$7;
      }
    }), _el$11);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return view()?.ux;
      },
      get children() {
        var _el$0 = _$createElement("text"),
          _el$1 = _$createTextNode(`UX 未验证 · `),
          _el$10 = _$createTextNode(` · 代码完成不代表 UX 通过`);
        _$insertNode(_el$0, _el$1);
        _$insertNode(_el$0, _el$10);
        _$insert(_el$0, () => view()?.ux?.reason === 'no-device' ? '未提供设备' : '设备证据未核验', _el$10);
        _$effect(_$p => _$setProp(_el$0, "fg", theme().textMuted, _$p));
        return _el$0;
      }
    }), _el$11);
    _$insertNode(_el$11, _el$12);
    _$insertNode(_el$11, _el$17);
    _$insertNode(_el$11, _el$21);
    _$setProp(_el$11, "padding", 1);
    _$setProp(_el$11, "flexDirection", "column");
    _$setProp(_el$11, "gap", 1);
    _$insertNode(_el$12, _el$13);
    _$insertNode(_el$12, _el$16);
    _$setProp(_el$12, "flexDirection", "row");
    _$setProp(_el$12, "justifyContent", "space-between");
    _$insertNode(_el$13, _el$14);
    _$insertNode(_el$13, _el$15);
    _$insert(_el$13, done, _el$14);
    _$insert(_el$13, () => tasks().length, _el$15);
    _$insert(_el$13, () => tasks().filter(task => task.status === 'running').length, null);
    _$insert(_el$13, (() => {
      var _c$ = _$memo(() => !!view()?.maxConcurrency);
      return () => _c$() ? ` · 最多同时 ${view()?.maxConcurrency} 个` : '';
    })(), null);
    _$insert(_el$16, elapsed);
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$19);
    _$insertNode(_el$17, _el$20);
    _$insert(_el$17, () => '━'.repeat(Math.round(percent() / 5)), _el$18);
    _$insert(_el$18, () => '─'.repeat(20 - Math.round(percent() / 5)));
    _$insert(_el$17, percent, _el$20);
    _$setProp(_el$21, "wrapMode", "word");
    _$insert(_el$21, () => view()?.detail ?? '使用 /one_duo 启动一多适配，或用 /dag_run 运行已有的任务图。');
    _$insertNode(_el$22, _el$23);
    _$insertNode(_el$22, _el$25);
    _$insertNode(_el$22, _el$27);
    _$setProp(_el$22, "flexDirection", "row");
    _$setProp(_el$22, "paddingLeft", 1);
    _$setProp(_el$22, "paddingRight", 1);
    _$setProp(_el$22, "gap", 2);
    _$insertNode(_el$23, _$createTextNode(`节点（按步骤自上而下执行，同一步里的节点同时执行）`));
    _$setProp(_el$23, "flexGrow", 1);
    _$insertNode(_el$25, _$createTextNode(`状态`));
    _$setProp(_el$25, "width", 10);
    _$insertNode(_el$27, _$createTextNode(`PR`));
    _$setProp(_el$27, "width", 8);
    _$setProp(_el$29, "flexGrow", 1);
    _$insert(_el$29, _$createComponent(For, {
      get each() {
        return keys();
      },
      children: (key, index) => {
        const row = () => rowOf(key);
        return (() => {
          var _el$41 = _$createElement("box"),
            _el$42 = _$createElement("text"),
            _el$43 = _$createElement("span"),
            _el$46 = _$createElement("text"),
            _el$47 = _$createElement("text");
          _$insertNode(_el$41, _el$42);
          _$insertNode(_el$41, _el$46);
          _$insertNode(_el$41, _el$47);
          _$setProp(_el$41, "flexDirection", "row");
          _$setProp(_el$41, "gap", 2);
          _$setProp(_el$41, "paddingLeft", 1);
          _$setProp(_el$41, "paddingRight", 1);
          _$setProp(_el$41, "onMouseUp", () => {
            if (row().kind === 'header') return;
            setSelected(index());
            props.open(row().node);
          });
          _$insertNode(_el$42, _el$43);
          _$setProp(_el$42, "flexGrow", 1);
          _$setProp(_el$42, "flexShrink", 1);
          _$setProp(_el$42, "truncate", true);
          _$insert(_el$43, () => row().prefix);
          _$insert(_el$42, _$createComponent(Show, {
            get when() {
              return row().kind !== 'header';
            },
            get children() {
              var _el$44 = _$createElement("span"),
                _el$45 = _$createTextNode(` `);
              _$insertNode(_el$44, _el$45);
              _$insert(_el$44, () => glyph(row().node.status), _el$45);
              _$effect(_$p => _$setProp(_el$44, "fg", color(row().node.status), _$p));
              return _el$44;
            }
          }), null);
          _$insert(_el$42, () => row().label, null);
          _$setProp(_el$46, "width", 10);
          _$insert(_el$46, (() => {
            var _c$2 = _$memo(() => !!(row().kind === 'review' || row().kind === 'header'));
            return () => _c$2() ? '' : _$memo(() => !!row().node.retry?.waiting)() ? '等待重试' : _$memo(() => !!row().node.noChange)() ? '无需改动' : label(row().node.status);
          })());
          _$setProp(_el$47, "width", 8);
          _$insert(_el$47, (() => {
            var _c$3 = _$memo(() => !!row().node.pr);
            return () => _c$3() ? '#' + row().node.pr : '';
          })());
          _$effect(_p$ => {
            var _v$15 = row().gap ? 2 : 1,
              _v$16 = index() === selected() && row().kind !== 'header' ? theme().backgroundElement : theme().background,
              _v$17 = row().kind === 'review' || row().kind === 'header' ? theme().textMuted : theme().text,
              _v$18 = theme().textMuted,
              _v$19 = color(row().node.status),
              _v$20 = row().node.pr ? theme().primary : theme().textMuted;
            _v$15 !== _p$.e && (_p$.e = _$setProp(_el$41, "height", _v$15, _p$.e));
            _v$16 !== _p$.t && (_p$.t = _$setProp(_el$41, "backgroundColor", _v$16, _p$.t));
            _v$17 !== _p$.a && (_p$.a = _$setProp(_el$42, "fg", _v$17, _p$.a));
            _v$18 !== _p$.o && (_p$.o = _$setProp(_el$43, "fg", _v$18, _p$.o));
            _v$19 !== _p$.i && (_p$.i = _$setProp(_el$46, "fg", _v$19, _p$.i));
            _v$20 !== _p$.n && (_p$.n = _$setProp(_el$47, "fg", _v$20, _p$.n));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined,
            n: undefined
          });
          return _el$41;
        })();
      }
    }), null);
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return !rows().length;
      },
      get children() {
        var _el$30 = _$createElement("text");
        _$insertNode(_el$30, _$createTextNode(`暂无节点`));
        _$effect(_$p => _$setProp(_el$30, "fg", theme().textMuted, _$p));
        return _el$30;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!rows()[selected()]?.node.detail)() && !rows()[selected()]?.node.error;
      },
      get children() {
        var _el$32 = _$createElement("text");
        _$setProp(_el$32, "wrapMode", "word");
        _$insert(_el$32, () => rows()[selected()]?.node.detail);
        _$effect(_$p => _$setProp(_el$32, "fg", theme().textMuted, _$p));
        return _el$32;
      }
    }), _el$34);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return rows()[selected()]?.node.error;
      },
      get children() {
        var _el$33 = _$createElement("text");
        _$setProp(_el$33, "wrapMode", "word");
        _$insert(_el$33, () => rows()[selected()]?.node.error);
        _$effect(_$p => _$setProp(_el$33, "fg", theme().error, _$p));
        return _el$33;
      }
    }), _el$34);
    _$insertNode(_el$34, _el$35);
    _$insertNode(_el$34, _el$37);
    _$setProp(_el$34, "flexDirection", "row");
    _$setProp(_el$34, "justifyContent", "space-between");
    _$insertNode(_el$35, _$createTextNode(`↑↓ 选择节点 · Enter / 点击 打开该节点的 Agent · Esc 返回会话`));
    _$insertNode(_el$37, _el$38);
    _$insert(_el$37, () => running() ? ' · c 取消运行' : '', null);
    _$insertNode(_el$39, _$createTextNode(`Agent 详情中按 ↑ 或点击底部「返回 DAG 看板」回到这里。`));
    _$effect(_p$ => {
      var _v$ = theme().background,
        _v$2 = theme().text,
        _v$3 = color(view()?.status),
        _v$4 = theme().textMuted,
        _v$5 = theme().backgroundPanel,
        _v$6 = theme().text,
        _v$7 = theme().textMuted,
        _v$8 = theme().primary,
        _v$9 = theme().textMuted,
        _v$0 = view()?.status === '启动失败' ? theme().error : theme().textMuted,
        _v$1 = theme().textMuted,
        _v$10 = theme().textMuted,
        _v$11 = theme().textMuted,
        _v$12 = theme().textMuted,
        _v$13 = theme().textMuted,
        _v$14 = theme().textMuted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$11, "backgroundColor", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$13, "fg", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$16, "fg", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$17, "fg", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$18, "fg", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp(_el$21, "fg", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp(_el$23, "fg", _v$1, _p$.l));
      _v$10 !== _p$.u && (_p$.u = _$setProp(_el$25, "fg", _v$10, _p$.u));
      _v$11 !== _p$.c && (_p$.c = _$setProp(_el$27, "fg", _v$11, _p$.c));
      _v$12 !== _p$.w && (_p$.w = _$setProp(_el$35, "fg", _v$12, _p$.w));
      _v$13 !== _p$.m && (_p$.m = _$setProp(_el$37, "fg", _v$13, _p$.m));
      _v$14 !== _p$.f && (_p$.f = _$setProp(_el$39, "fg", _v$14, _p$.f));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined,
      u: undefined,
      c: undefined,
      w: undefined,
      m: undefined,
      f: undefined
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
      var _el$48 = _$createElement("box"),
        _el$49 = _$createElement("text"),
        _el$51 = _$createElement("text");
      _$insertNode(_el$48, _el$49);
      _$insertNode(_el$48, _el$51);
      _$setProp(_el$48, "flexDirection", "row");
      _$setProp(_el$48, "paddingLeft", 2);
      _$setProp(_el$48, "paddingRight", 2);
      _$setProp(_el$48, "height", 1);
      _$insertNode(_el$49, _$createTextNode(`↑ 返回 DAG 看板`));
      _$insertNode(_el$51, _$createTextNode(` 按上方向键或点击这里`));
      _$effect(_p$ => {
        var _v$21 = props.api.theme.current.backgroundPanel,
          _v$22 = props.back,
          _v$23 = props.api.theme.current.primary,
          _v$24 = props.api.theme.current.textMuted;
        _v$21 !== _p$.e && (_p$.e = _$setProp(_el$48, "backgroundColor", _v$21, _p$.e));
        _v$22 !== _p$.t && (_p$.t = _$setProp(_el$48, "onMouseUp", _v$22, _p$.t));
        _v$23 !== _p$.a && (_p$.a = _$setProp(_el$49, "fg", _v$23, _p$.a));
        _v$24 !== _p$.o && (_p$.o = _$setProp(_el$51, "fg", _v$24, _p$.o));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined
      });
      return _el$48;
    }
  });
}
