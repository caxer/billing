// Resolve renamed data repositories after decryption; existing vaults stay valid.
export function dataRepoPath(repo) {
  const aliases = {
    'caxer/shared-ledger-records': 'caxer/billing-data',
    'caxer/scan-solver-logs': 'caxer/teacher-data',
  };
  return aliases[repo] || repo;
}

export function normalizeDataCredentials(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.github?.repo) return { ...value, github: { ...value.github, repo: dataRepoPath(value.github.repo) } };
  if (value.owner && value.repo) {
    const path = dataRepoPath(`${value.owner}/${value.repo}`);
    return { ...value, repo: path.slice(path.indexOf('/') + 1) };
  }
  return value;
}
