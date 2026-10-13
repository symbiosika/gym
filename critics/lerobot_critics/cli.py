"""Command line interface: ``lerobot-critics run|episodes|markdown|html|init-spec|critics|serve``."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import typer
from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn
from rich.table import Table

app = typer.Typer(help="Episode quality critics for LeRobot datasets.", no_args_is_help=True)
console = Console()


def _parse_episodes(s: str | None) -> list[int] | None:
    from .runner import parse_episodes

    return parse_episodes(s)


@app.command()
def run(
    datasets: list[Path] = typer.Argument(..., help="One or more LeRobot dataset directories"),
    spec: Path | None = typer.Option(
        None, "--spec", "-s", help="Critic spec YAML/JSON (default: auto from dataset)"
    ),
    out: Path = typer.Option(Path("critic_out"), "--out", "-o"),
    episodes: str | None = typer.Option(None, "--episodes", "-e", help="e.g. 0,3,7-9"),
    workers: int = typer.Option(
        0, "--workers", "-w", help="process workers for hard critics (0 = cpu count)"
    ),
    no_vlm: bool = typer.Option(False, "--no-vlm", help="skip the VLM soft critics"),
    hard_only: bool = typer.Option(False, "--hard-only", help="alias for --no-vlm"),
    no_sheets: bool = typer.Option(False, "--no-sheets", help="skip contact sheets"),
    vlm_model: str | None = typer.Option(None, "--vlm-model", help="override spec.soft_critics.vlm.model"),
    vlm_mode: str | None = typer.Option(None, "--vlm-mode", help="agentic | static | frames"),
):
    """Run all critics on one or more datasets and write report.json / report.md / selection.json."""
    from .runner import RunOptions
    from .runner import run as _run
    from .spec.autospec import auto_spec
    from .spec.models import load_spec

    for dataset in datasets:
        cs = load_spec(spec) if spec else auto_spec(dataset)
        if vlm_model:
            cs.soft_critics.vlm.model = vlm_model
        if vlm_mode:
            cs.soft_critics.vlm.mode = vlm_mode  # type: ignore[assignment]
        ds_out = out if len(datasets) == 1 else out / Path(dataset).name
        opts = RunOptions(
            episodes=_parse_episodes(episodes),
            out_dir=str(ds_out),
            workers=workers,
            run_soft=not (no_vlm or hard_only),
            contact_sheets=not no_sheets,
        )
        with Progress(
            TextColumn("{task.description}"),
            BarColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
            console=console,
        ) as prog:
            tasks: dict[str, int] = {}

            def cb(stage: str, done: int, total: int, prog=prog, tasks=tasks) -> None:
                if stage not in tasks:
                    tasks[stage] = prog.add_task(f"{stage} critics", total=total)
                prog.update(tasks[stage], completed=done)

            report = _run(dataset, cs, opts, progress=cb)
        _print_summary(report)
        console.print(
            f"\nreports written to [bold]{ds_out}[/bold] "
            "(report.md, report.html, report_ai.md, report.json, episodes.csv, selection.json)"
        )
        console.print(
            f"[dim]for an AI assistant: lerobot-critics markdown {ds_out} --copy   "
            "(or paste report_ai.md)[/dim]"
        )
        console.print(f"[dim]visual report (charts, print to PDF): {ds_out / 'report.html'}[/dim]")


def _print_summary(report) -> None:
    c = report.counts
    console.print(
        f"\n[bold]{report.dataset_name}[/bold]: [green]{c.get('accept', 0)} accept[/green] · "
        f"[yellow]{c.get('review', 0)} review[/yellow] · [red]{c.get('reject', 0)} reject[/red]"
    )
    t = Table(show_lines=False)
    for col in ("ep", "verdict", "total", "hard", "soft", "flags"):
        t.add_column(col)
    for r in sorted(report.episodes, key=lambda r: r.score.total if r.score.total is not None else -1):
        color = {"accept": "green", "review": "yellow", "reject": "red"}[r.score.verdict]
        f = lambda x: "–" if x is None else f"{x:.2f}"  # noqa: E731
        t.add_row(
            str(r.episode),
            f"[{color}]{r.score.verdict}[/{color}]",
            f(r.score.total),
            f(r.score.hard_score),
            f(r.score.soft_score),
            " ".join(r.score.flags)[:80],
        )
    console.print(t)


def copy_to_clipboard(text: str) -> str:
    """Copy ``text`` to the system clipboard with whatever tool exists; returns the tool's name."""
    import shutil

    for cmd in (
        ["pbcopy"],
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
        ["clip"],
    ):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, input=text.encode("utf-8"), check=True)
            return cmd[0]
    raise RuntimeError("no clipboard tool found (pbcopy, wl-copy, xclip, xsel or clip); pipe stdout instead")


@app.command()
def markdown(
    source: Path = typer.Argument(
        ..., help="Output directory of a finished run (contains report.json) or a report.json file"
    ),
    out: Path | None = typer.Option(None, "--out", "-o", help="write to this file instead of stdout"),
    detail: str = typer.Option(
        "full",
        "--detail",
        "-d",
        help="summary (run, task, checks, score table) | flagged (+ details for review/reject) | full (+ all episodes)",
    ),
    episodes: str | None = typer.Option(
        None, "--episodes", "-e", help="restrict the score table and details to e.g. 0,3,7-9"
    ),
    episode: int | None = typer.Option(
        None, "--episode", help="only this episode (a short, self-contained block instead of the whole run)"
    ),
    copy: bool = typer.Option(
        False, "--copy", "-c", help="copy to the clipboard (pbcopy / wl-copy / xclip / clip)"
    ),
):
    """Render a finished run as self-contained, AI-readable Markdown ("copy as Markdown").

    The document explains the scoring, states the task and every check that ran, adds a
    glossary of the flags and lists every episode's scores, flags, metrics, evidence and
    VLM verdict as Markdown tables - paste it into an LLM chat or hand it to an agent.
    """
    from .ai_report import DETAIL_LEVELS, load_report, render_ai_markdown, render_episode_markdown

    if detail not in DETAIL_LEVELS:
        raise typer.BadParameter(f"--detail must be one of {', '.join(DETAIL_LEVELS)}", param_hint="--detail")
    try:
        report = load_report(source)
    except FileNotFoundError as e:
        raise typer.BadParameter(str(e), param_hint="SOURCE") from e
    if episode is not None:
        try:
            text = render_episode_markdown(report, episode)
        except KeyError as e:
            raise typer.BadParameter(str(e), param_hint="--episode") from e
    else:
        try:
            subset = _parse_episodes(episodes)
        except ValueError as e:
            raise typer.BadParameter(f"bad episodes list {episodes!r}", param_hint="--episodes") from e
        text = render_ai_markdown(report, detail=detail, episodes=subset)
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        console.print(f"wrote {out} ({len(text) // 1024} KB)")
    if copy:
        try:
            tool = copy_to_clipboard(text)
        except (RuntimeError, OSError, subprocess.SubprocessError) as e:
            console.print(f"[red]clipboard copy failed: {e}[/red]")
            raise typer.Exit(1) from e
        console.print(f"copied {len(text) // 1024} KB of Markdown to the clipboard via {tool}")
    if out is None and not copy:
        typer.echo(text, nl=False)


@app.command()
def html(
    source: Path = typer.Argument(
        ..., help="Output directory of a finished run (contains report.json) or a report.json file"
    ),
    out: Path | None = typer.Option(
        None, "--out", "-o", help="write here (default: report.html next to the report.json)"
    ),
    top: int = typer.Option(
        5, "--top", "-t", help="how many of the most conspicuous episodes to analyse in detail"
    ),
    show: bool = typer.Option(False, "--open", help="open the finished report in the default browser"),
):
    """Render a finished run as a visual, printable HTML report ("visual report").

    One overview page with charts (verdict split, score per episode, weakest check, most
    frequent findings) plus a detail analysis of the ``--top`` most conspicuous episodes,
    with their contact sheets embedded. A single self-contained file - print it to PDF from
    the browser.
    """
    from .ai_report import load_report
    from .visual_report import render_html_report

    try:
        report = load_report(source)
    except FileNotFoundError as e:
        raise typer.BadParameter(str(e), param_hint="SOURCE") from e
    run_dir = source if source.is_dir() else source.parent
    dest = out or run_dir / "report.html"
    text = render_html_report(report, out_dir=run_dir, top_n=top)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")
    console.print(f"wrote {dest} ({len(text) // 1024} KB) - open it and print to PDF for a shareable report")
    if show:
        import webbrowser

        webbrowser.open(dest.resolve().as_uri())


@app.command()
def episodes(
    source: Path = typer.Argument(
        ..., help="Output directory of a finished run (contains report.json) or a report.json file"
    ),
    verdict: str = typer.Option(
        "all", "--verdict", "-v", help="accept | review | reject | accept+review | all"
    ),
    fmt: str = typer.Option("table", "--format", "-f", help="table | list | ranges | json"),
    why: bool = typer.Option(False, "--why", help="also print why every filtered episode was filtered"),
    switchable: bool = typer.Option(
        False, "--switchable", help="which findings decide verdicts and what muting them gives back"
    ),
):
    """Print the episode numbers of a finished run: what to train on, what to drop, and why.

    ``--format ranges`` prints the compact ``0-12,14`` form that ``--episodes`` takes,
    ``--format list`` one number per line for a shell loop, ``--format json`` the whole
    selection (the same content as ``selection.json``).
    """
    from .ai_report import load_report
    from .report import build_selection
    from .selection import compact_ranges, filtered_episodes, flag_impact, impact_text, selection_lists

    try:
        report = load_report(source)
    except FileNotFoundError as e:
        raise typer.BadParameter(str(e), param_hint="SOURCE") from e
    wanted = {
        "all": ["accept", "review", "reject"],
        "accept": ["accept"],
        "review": ["review"],
        "reject": ["reject"],
        "accept+review": ["accept", "review"],
    }.get(verdict.lower())
    if wanted is None:
        raise typer.BadParameter("use accept | review | reject | accept+review | all", param_hint="--verdict")
    lists = selection_lists(report)
    eps = sorted(e for v in wanted for e in lists[v]["episodes"])
    if fmt == "json":
        typer.echo(json.dumps(build_selection(report), indent=1))
        return
    if fmt == "list":
        for e in eps:
            typer.echo(str(e))
        return
    if fmt == "ranges":
        typer.echo(compact_ranges(eps))
        return
    if fmt != "table":
        raise typer.BadParameter("use table | list | ranges | json", param_hint="--format")
    for v in wanted:
        d = lists[v]
        console.print(f"[bold]{v}[/bold] ({d['n']}, {d['meaning']}): {d['ranges'] or '-'}")
    if len(wanted) > 1:
        console.print(
            f"[dim]accept+review: {compact_ranges(lists['accept']['episodes'] + lists['review']['episodes'])}[/dim]"
        )
    if why:
        rows = [d for d in filtered_episodes(report) if d["verdict"] in wanted]
        if rows:
            console.print("\n[bold]why filtered[/bold]")
        for d in rows:
            blocking = " ".join(d["blocking"]) or "score only"
            console.print(f"  [bold]ep {d['episode']}[/bold] {d['verdict']}: {d['headline']}")
            console.print(f"      decided by: [cyan]{blocking}[/cyan]")
            for line in d["details"][:3]:
                console.print(f"      - [dim]{line}[/dim]")
    if switchable:
        rows = [d for d in flag_impact(report) if d["decides"]]
        console.print("\n[bold]findings that decide verdicts[/bold] (mute via scoring.ignore_flags)")
        for d in rows:
            back = impact_text(d) or "nothing - those episodes are filtered by their score too"
            console.print(
                f"  [cyan]{d['flag']}[/cyan] {d['effect']}; decides {len(d['decides'])} episode(s); "
                f"if muted: {back}"
            )


@app.command("init-spec")
def init_spec(
    dataset: Path = typer.Argument(..., help="LeRobot dataset directory"),
    out: Path = typer.Option(Path("spec.yaml"), "--out", "-o"),
    active_arm: str | None = typer.Option(None, help="e.g. left"),
    purpose: str = typer.Option(
        "recording",
        "--purpose",
        help="recording (demonstrations for training) | evaluation (policy rollouts)",
    ),
):
    """Write a starter spec (task text, robot, cameras, default critics) for a dataset."""
    from .spec.autospec import auto_spec
    from .spec.models import save_spec

    if purpose not in ("recording", "evaluation"):
        raise typer.BadParameter("use recording | evaluation", param_hint="--purpose")
    cs = auto_spec(dataset, active_arms=[active_arm] if active_arm else None, purpose=purpose)  # type: ignore[arg-type]
    save_spec(cs, out)
    console.print(f"wrote {out}")
    console.print(cs.to_yaml())


@app.command()
def critics():
    """List built-in hard critics with their default parameters."""
    from .critics.registry import list_hard_critics

    for c in list_hard_critics():
        console.print(f"[bold]{c['id']}[/bold]: {c['description']}")
        console.print("  defaults: " + json.dumps(c["default_params"]))


@app.command()
def metrics(critic: str | None = typer.Argument(None, help="Only this critic's metrics")):
    """Explain every metric the hard critics emit: what it measures and how it is computed."""
    from .metrics_doc import all_metric_docs

    docs = all_metric_docs(critic)
    if not docs:
        console.print(f"[red]no metrics documented for critic '{critic}'[/red]")
        raise typer.Exit(1)
    cur = None
    for d in docs:
        if d["critic"] != cur:
            cur = d["critic"]
            console.print(f"\n[bold]{cur}[/bold]")
        key = d["key"] + ("<feature>" if d["per_feature"] else "")
        console.print(f"  [cyan]{key}[/cyan]  unit={d['unit']}  better={d['better']}  - {d['label']}")
        console.print(f"      what: {d['what']}")
        console.print(f"      how:  {d['how']}")


@app.command()
def serve(host: str = "0.0.0.0", port: int = 8080, workers: int = 1):
    """Start the REST API."""
    import uvicorn

    uvicorn.run("lerobot_critics.api.app:app", host=host, port=port, workers=workers)


if __name__ == "__main__":  # pragma: no cover
    app()
