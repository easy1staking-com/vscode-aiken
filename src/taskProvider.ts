import * as vscode from "vscode";

interface AikenTaskDefinition extends vscode.TaskDefinition {
  command: string;
}

export class AikenTaskProvider implements vscode.TaskProvider {
  static readonly type = "aiken";

  public provideTasks(): vscode.Task[] {
    const binary = this.getBinary();
    return [
      this.createTask("Build project", "build", binary, vscode.TaskGroup.Build),
      this.createTask("Run tests", "check", binary, vscode.TaskGroup.Test),
      this.createTask("Run benchmarks", "bench", binary, vscode.TaskGroup.Test),
    ];
  }

  public resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as AikenTaskDefinition;
    if (def.command) {
      return this.createTask(task.name, def.command, this.getBinary());
    }
    return undefined;
  }

  private getBinary(): string {
    const config = vscode.workspace.getConfiguration("aiken");
    return config.get<string>("server.path", "") || "aiken";
  }

  private createTask(
    name: string,
    command: string,
    binary: string,
    group?: vscode.TaskGroup,
  ): vscode.Task {
    const def: AikenTaskDefinition = { type: AikenTaskProvider.type, command };
    const execution = new vscode.ShellExecution(`${binary} ${command}`);
    const task = new vscode.Task(
      def,
      vscode.TaskScope.Workspace,
      name,
      "aiken",
      execution,
      "$aiken",
    );
    if (group) {
      task.group = group;
    }
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always };
    return task;
  }
}
