document.getElementById('reload').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' });
  if (tabs.length === 0) {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active[0]) chrome.tabs.reload(active[0].id);
  } else {
    tabs.forEach((t) => chrome.tabs.reload(t.id));
  }
  window.close();
});
