// Fixed, read-only extractor for the dedicated Devin window. It returns only
// bounded labels and numbers; raw page text, HTML, cookies, and tokens never
// cross into Phantom. Native validates this answer again before displaying it.
(function () {
  var S = JSON.stringify
  try {
    if (window !== window.top || location.origin !== 'https://app.devin.ai') return S({ error: 'origin' })
    var match = /^\/org\/([A-Za-z0-9_-]{1,120})\/settings\/(general|usage)$/.exec(location.pathname)
    if (!match) return S({ error: 'page' })
    var slug = match[1]
    var page = match[2]
    var nonce = window.__ashlrDevinReaderNonce
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return S({ error: 'document' })
    var visible = function (e) { return e && e.getClientRects().length > 0 }
    var text = function (e) { return (e && e.textContent || '').replace(/\s+/g, ' ').trim() }
    if (page === 'general') {
      var labels = Array.from(document.querySelectorAll('h4')).filter(function (e) { return visible(e) && text(e) === 'Organization ID' })
      if (labels.length !== 1) return S({ error: 'org-label' })
      var box = labels[0].parentElement && labels[0].parentElement.parentElement && labels[0].parentElement.parentElement.parentElement
      if (!box) return S({ error: 'org-field' })
      var ids = Array.from(box.querySelectorAll('p')).filter(visible).map(text).filter(function (v) { return /^org-[A-Za-z0-9_-]{1,120}$/.test(v) })
      if (ids.length !== 1) return S({ error: 'org-value' })
      return S({ page: 'general', slug: slug, documentNonce: nonce, orgId: ids[0] })
    }
    var panel = document.querySelector('[role="tabpanel"]')
    if (!visible(panel) || !/^Usage & limits$/i.test(text(document.querySelector('h2')))) return S({ error: 'usage-heading' })
    var spans = Array.from(panel.querySelectorAll('span')).filter(visible)
    var exact = function (re) { return spans.filter(function (e) { return re.test(text(e)) }) }
    // The number must belong to a compact weekly allowance section, not an
    // unrelated percentage elsewhere on the Usage page.
    var weekly = spans.filter(function (e) {
      if (!/^(?:100|[1-9]?\d)% used$/.test(text(e))) return false
      var row = e.parentElement
      for (var depth = 0; row && row !== panel && depth < 4; depth++, row = row.parentElement) {
        if (text(row).length > 240) break
        var labels = Array.from(row.querySelectorAll('span')).filter(visible).map(text)
        if (labels.some(function (v) { return /\bweekly\b/i.test(v) }) &&
            labels.some(function (v) { return /^Resets in \d{1,3} days?$/.test(v) })) return true
      }
      return false
    })
    var balances = exact(/^\$\d{1,6}(?:\.\d{2})?$/)
    var balanceLabels = exact(/^Remaining balance$/i)
    var plan = Array.from(panel.querySelectorAll('h3')).filter(function (e) { return visible(e) && /^Max$/i.test(text(e)) })
    var monthly = []
    var planRenews = []
    if (plan.length === 1) {
      var card = plan[0].parentElement
      for (var level = 0; card && card !== panel && level < 4; level++, card = card.parentElement) {
        if (text(card).length > 240) break
        // The provider renders plan price/renewal as leaf divs as well as
        // spans. Admit bounded text fields, excluding their duplicate wrappers.
        var fields = Array.from(card.querySelectorAll('span,div,p')).filter(function (e) {
          return visible(e) && e.children.length === 0
        })
        var prices = fields.filter(function (e) { return /^\$\d{1,6}(?:\.\d{2})?\/month$/i.test(text(e)) })
        var renewals = fields.map(text).filter(function (v) { return /^Renews on [A-Za-z]+ \d{1,2}, \d{4}$/.test(v) })
        if (prices.length === 1 && renewals.length > 0) { monthly = prices; planRenews = renewals; break }
      }
    }
    // A value is accepted only when its label/value share the same small
    // visible container. Do not infer a cash balance from an unrelated price.
    var balance = null
    if (balanceLabels.length === 1) {
      var row = balanceLabels[0].parentElement
      var inRow = balances.filter(function (e) { return row && row.contains(e) })
      if (inRow.length === 1) balance = text(inRow[0])
    }
    var resets = exact(/^Resets in \d{1,3} days?$/).map(text)
    var renews = planRenews
    var autoLabels = Array.from(panel.querySelectorAll('label,[aria-label]')).filter(function (e) {
      return visible(e) && /^Auto-?reload$/i.test(text(e) || e.getAttribute('aria-label') || '')
    })
    var autoReload = null
    if (autoLabels.length === 1) {
      var root = autoLabels[0].parentElement
      var switches = root ? Array.from(root.querySelectorAll('[role="switch"][aria-checked]')).filter(visible) : []
      if (switches.length === 1) autoReload = switches[0].getAttribute('aria-checked') === 'true'
    }
    if (weekly.length !== 1 || balance === null || plan.length !== 1 || monthly.length !== 1) return S({ error: 'usage-fields' })
    return S({ page: 'usage', slug: slug, documentNonce: nonce, weeklyUsedPercent: Number(text(weekly[0]).slice(0, -6)),
      onDemandBalanceUsd: Number(balance.slice(1)), plan: 'Max', monthlyPriceUsd: Number(text(monthly[0]).slice(1).split('/')[0]),
      resetProse: resets.length === 1 ? resets[0] : null,
      renewalProse: renews.length === 1 ? renews[0] : null,
      autoReload: autoReload })
  } catch (_) {
    return S({ error: 'read-failed' })
  }
})()
