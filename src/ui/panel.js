// 天体资料面板
export class Panel {
  constructor(onClose) {
    this.el = document.getElementById('panel');
    this.name = document.getElementById('panel-name');
    this.en = document.getElementById('panel-en');
    this.kind = document.getElementById('panel-kind');
    this.index = document.getElementById('panel-index');
    this.line = document.getElementById('panel-line');
    this.data = document.getElementById('panel-data');
    this.open = false;
    this.current = null;

    document.getElementById('panel-close').addEventListener('click', () => {
      this.hide();
      if (onClose) onClose();
    });
  }

  show(def, indexLabel) {
    this.name.textContent = def.name;
    this.en.textContent = def.en;
    this.kind.textContent = def.kind;
    this.index.textContent = indexLabel || '';
    this.line.textContent = def.line || '';

    this.data.innerHTML = def.data.map(([k, v, u]) =>
      `<div class="row"><dt>${k}</dt><dd>${v}${u ? `<em>${u}</em>` : ''}</dd></div>`
    ).join('');

    this.el.classList.remove('is-hidden');
    // 强制重排后再加 is-open，保证过渡生效
    void this.el.offsetWidth;
    this.el.classList.add('is-open');
    this.open = true;
    this.current = def.id;
    // 面板占住右上角，沉浸模式按钮要给它让位
    document.body.classList.add('has-panel');
  }

  hide() {
    if (!this.open) return;
    this.el.classList.remove('is-open');
    this.open = false;
    this.current = null;
    document.body.classList.remove('has-panel');
    setTimeout(() => { if (!this.open) this.el.classList.add('is-hidden'); }, 560);
  }
}
