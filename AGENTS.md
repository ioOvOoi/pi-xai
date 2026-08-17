# AGENTS

## 必须遵守

开发过程中需明确按照 skill: wayfinder-> to-spec ->to-tickets ->implement ->code-review，的方式去对每一个大模块进行拆分工作，使用GithubCLI在Git仓库中提交议题的方式进行。大模块更新必须使用 分支的方式进行开发 检验完成在合并到main。开发过程中优先写好debug,程序与美术模块分离.
每一小步进行一次中文git提交，详细描述更改以及任务。
Break your requirement down into small, test‑able functions before writing any code.
Match the existing code‑style and architecture inside your current repository.
Add defensive checks for edge‑case inputs and handle runtime exceptions gracefully.
Never deliver incomplete code that cannot run without extra manual modification.
Wrap complicated logic into independent helper‑functions to improve readability.
