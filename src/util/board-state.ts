import {
    createStrictColumnJson,
    createStrictKanbanJson,
    createTaskJson,
} from './kanban-type-functions';
import VsCodeHandler from './vscode-handler';
import DelayedUpdater from './delayed-updater';
import clone from 'just-clone';
declare var acquireVsCodeApi: () => VsCodeApi;

/**
 * Enumeration of possible board state changes that can occur.
 */
export enum StateChanges {
    // Board setting changes
    AUTOSAVE,
    SAVE_TO_FILE,
    BOARD_TITLE,

    // Column-specific changes
    COLUMN_ADDED,
    COLUMN_DELETED,
    COLUMN_TITLE,
    COLUMN_COLOR,
    COLUMN_MOVED,

    // Task-specific changes
    TASK_ADDED,
    TASK_DELETED,
    TASK_MOVED,
    TASK_TEXT,

    // Board-wide kanban changes
    HISTORY_REVERSED,
    BOARD_LOADED,
}

export type HistoryObject = {
    change: StateChanges;
    data: StrictKanbanJSON;
    details: string;
};

/**
 * Manages the state of a Kanban board. All state modifications should happen through this object, so that it can keep track of them.
 */
class BoardState {
    /**
     * Instantiate Object and load VsCode API if it's available.
     */
    constructor() {
        let vscodeApi: VsCodeApi | null = null;
        if (typeof acquireVsCodeApi === 'undefined') {
            vscodeApi = {
                postMessage: () => {
                    return;
                },
            };
        } else {
            vscodeApi = acquireVsCodeApi();
        }

        this.vscodeHandler = new VsCodeHandler(vscodeApi);
        this.vscodeHandler.addLoadListener(this.loadFromVscode);
        this.vscodeHandler.load();
    }

    /**
     * Add a callback to be run whenever the current kanban state is changed
     *
     * @param listener callback to be added
     */
    public addKanbanChangeListener(
        listener: (kanban: StrictKanbanJSON) => void
    ) {
        this.kanbanChangeListeners.push(listener);
    }

    /**
     * Remove a callback added with addKanbanChangeListener().
     *
     * @param listener callback to be removed
     */
    public removeKanbanChangeListener(
        listener: (kanban: StrictKanbanJSON) => void
    ) {
        this.kanbanChangeListeners = this.kanbanChangeListeners.filter(
            (l) => l !== listener
        );
    }

    /**
     * Run all kanban-change listeners.
     */
    public refreshKanban() {
        this.kanbanChangeListeners.forEach((listener) =>
            listener(this.currentKanban)
        );
    }

    /**
     * Add a callback to be run whenever the change history is updated.
     *
     * @param listener callback to be added
     */
    public addHistoryUpdateListener(
        listener: (history: HistoryObject) => void
    ) {
        this.historyUpdateListeners.push(listener);
    }

    /**
     * Remove a callback added with addHistoryUpdateListener().
     *
     * @param listener callback to be removed
     */
    public removeHistoryUpdateListener(
        listener: (history: HistoryObject) => void
    ) {
        this.historyUpdateListeners = this.historyUpdateListeners.filter(
            (l) => l !== listener
        );
    }

    /**
     * @returns a copy of this BoardState's history list
     */
    public getHistory() {
        return clone(this.history);
    }

    /**
     * Sets the autosave field of the current board state to newAutosave
     *
     * @param newAutosave desired autosave value for current board state
     */
    public changeAutosave(newAutosave: boolean): void {
        this.currentKanban.autosave = newAutosave;
        this.endChange(false);
    }

    /**
     * Sets the saveToFile field of the current board state to newAutosave
     *
     * @param newSaveToFile desired saveToFile value for current board state
     */
    public changeSaveToFile(newSaveToFile: boolean): void {
        this.currentKanban.saveToFile = newSaveToFile;
        this.endChange(false);
    }

    /**
     * Sets the title filed of the current board state to newTitle.
     *
     * By design, it takes a second for this change to be registered
     * in the Board State's change history.
     *
     * @param newTitle desired title for current board state
     */
    public changeBoardTitle(newTitle: string): void {
        if (!this.previousText.has('board')) {
            this.previousText.set('board', this.currentKanban.title);
        }
        const oldTitle = this.previousText.get('board')!;

        this.boardTextUpdater.tryUpdate(() => {
            const copy = clone(this.currentKanban);
            copy.title = oldTitle;

            this.history.push({
                change: StateChanges.BOARD_TITLE,
                data: copy,
                details: `From "${oldTitle}" to "${newTitle}"`,
            });

            this.previousText.delete('board');
        }, 'history-push');

        this.currentKanban.title = newTitle;
        this.endChange(true, this.boardTextUpdater);
    }

    /**
     * Appends a column to the current board state's column list.
     */
    public addColumn(): void {
        const columnName = `Column ${this.currentKanban.cols.length + 1}`;
        const column = createStrictColumnJson(columnName);

        this.currentKanban.cols.push(column);
        this.endChange(false);
    }

    /**
     * Removes a column with the given id from the current board state.
     *
     * @param id ID of column to remove
     */
    public removeColumn(id: string): void {
        const columnIdx = this.getColumnIndex(id);
        if (columnIdx === -1) {
            return;
        }

        this.history.push({
            change: StateChanges.COLUMN_DELETED,
            data: clone(this.currentKanban),
            details: `Deleted "${this.currentKanban.cols[columnIdx].title}"`,
        });

        this.currentKanban.cols.splice(columnIdx, 1);
        this.endChange(true);
    }

    /**
     * Changes the title of the column with the given id.
     *
     * By design, this change takes a second to register in the board state's
     * change history.
     *
     * @param id ID of column to edit
     * @param newTitle desired title of column
     */
    public changeColumnTitle(id: string, newTitle: string) {
        const columnIdx = this.getColumnIndex(id);
        if (columnIdx === -1) {
            return;
        }

        const column = this.currentKanban.cols[columnIdx];

        if (!this.previousText.has(column.id)) {
            this.previousText.set(column.id, column.title);
        }
        const oldTitle = this.previousText.get(column.id)!;

        this.columnTextUpdater.tryUpdate(() => {
            const copy = clone(this.currentKanban);
            copy.cols[columnIdx].title = oldTitle;

            this.history.push({
                change: StateChanges.COLUMN_TITLE,
                data: copy,
                details: `From "${oldTitle}" to "${newTitle}"`,
            });

            this.previousText.delete(column.id);
        }, 'history-push');

        this.currentKanban.cols[columnIdx].title = newTitle;

        this.endChange(true, this.columnTextUpdater);
    }

    /**
     * Changes the color of the column with the given id.
     *
     * @param id ID of column to edit
     * @param newColor desired color  of column
     */
    public changeColumnColor(id: string, newColor: string) {
        const columnIdx = this.getColumnIndex(id);
        if (columnIdx === -1) {
            return;
        }

        const column = this.currentKanban.cols[columnIdx];
        if (column.color === newColor) {
            return;
        }

        this.history.push({
            change: StateChanges.COLUMN_COLOR,
            data: clone(this.currentKanban),
            details: `"${column.title}" color changed`,
        });

        this.currentKanban.cols[columnIdx].color = newColor;
        this.endChange(true);
    }

    /**
     * Changes the position of the column with the given id to a
     * specified index in the current board state's column list.
     * Other columns will be shifted accommodate this movement.
     *
     * @param id ID of column to move
     * @param toIndex desired index of column
     */
    public moveColumn(id: string, toIndex: number) {
        if (toIndex < 0 || toIndex >= this.currentKanban.cols.length) {
            return;
        }

        const columnIdx = this.getColumnIndex(id);
        if (columnIdx === -1) {
            return;
        }

        this.history.push({
            change: StateChanges.COLUMN_MOVED,
            data: clone(this.currentKanban),
            details: `"${this.currentKanban.cols[columnIdx].title}" moved`,
        });

        const [column] = this.currentKanban.cols.splice(columnIdx, 1);
        this.currentKanban.cols.splice(toIndex, 0, column);
        this.endChange(true);
    }

    /**
     * Append's a task to the task list of the column with the given id.
     *
     * @param columnId ID of the column to add a task to
     */
    public addTask(columnId: string): void {
        const columnIdx = this.getColumnIndex(columnId);
        if (columnIdx === -1) {
            return;
        }

        this.currentKanban.cols[columnIdx].tasks.splice(0, 0, createTaskJson());
        this.endChange(false);
    }

    /**
     * Removes a task with the specified ID from the column with the given ID.
     *
     * @param columnId ID of column containing task to remove
     * @param taskId ID of task to remove
     */
    public removeTask(columnId: string, taskId: string): void {
        const columnIdx = this.getColumnIndex(columnId);
        if (columnIdx === -1) {
            return;
        }
        const column = this.currentKanban.cols[columnIdx];

        const taskIdx = column.tasks.findIndex((t) => t.id === taskId);
        if (taskIdx === -1) {
            return;
        }
        const task = column.tasks[taskIdx];
        const taskEmpty = task.text === '';

        if (!taskEmpty) {
            this.history.push({
                change: StateChanges.TASK_DELETED,
                data: clone(this.currentKanban),
                details: `"${task.text}" removed from "${column.title}"`,
            });
        }

        this.currentKanban.cols[columnIdx].tasks.splice(taskIdx, 1);
        this.endChange(!taskEmpty);
    }

    /**
     * Moves a task from one column and/or position to another column and/or position.
     *
     * sourceCol can equal destCol.
     *
     * @param sourceCol ID of column already containing task
     * @param destCol ID of column task should be moved to
     * @param sourceIndex starting position of task in SourceCol's task list
     * @param destIndex desired position in destCol's task list
     */
    public moveTask(
        sourceCol: string,
        destCol: string,
        sourceIndex: number,
        destIndex: number
    ): void {
        const sourceColIdx = this.getColumnIndex(sourceCol);
        const destColIdx = this.getColumnIndex(destCol);
        if (sourceColIdx === -1 || destColIdx === -1) {
            return;
        }

        const numSourceTasks =
            this.currentKanban.cols[sourceColIdx].tasks.length;
        const numDestTasks = this.currentKanban.cols[destColIdx].tasks.length;

        const destTooBig = // if destCol === sourceCol then task cannot be appended to end of list
            destCol === sourceCol
                ? destIndex >= numDestTasks
                : destIndex > numDestTasks;
        if (
            sourceIndex < 0 ||
            sourceIndex >= numSourceTasks ||
            destIndex < 0 ||
            destTooBig
        ) {
            return;
        }

        const [task] = this.currentKanban.cols[sourceColIdx].tasks.splice(
            sourceIndex,
            1
        );
        this.currentKanban.cols[destColIdx].tasks.splice(destIndex, 0, task);

        this.endChange(false);
    }

    /**
     * Change a task's text.
     *
     * By design, it takes a second for this change to register in
     * the BoardState's change history.
     *
     * @param columnId ID of column containing task to edit
     * @param taskId ID of task to edit
     * @param newText desired text of the task
     */
    public changeTaskText(
        columnId: string,
        taskId: string,
        newText: string
    ): void {
        const columnIdx = this.getColumnIndex(columnId);
        if (columnIdx === -1) {
            return;
        }

        const taskIdx = this.currentKanban.cols[columnIdx].tasks.findIndex(
            (task) => task.id === taskId
        );
        if (taskIdx === -1) {
            return;
        }

        if (!this.previousText.has(taskId)) {
            this.previousText.set(
                taskId,
                this.currentKanban.cols[columnIdx].tasks[taskIdx].text
            );
        }
        const oldText = this.previousText.get(taskId)!;

        this.taskTextUpdater.tryUpdate(() => {
            const copy = clone(this.currentKanban);
            copy.cols[columnIdx].tasks[taskIdx].text = oldText;

            this.history.push({
                change: StateChanges.TASK_TEXT,
                data: copy,
                details: `"${oldText}" changed to "${newText}"`,
            });

            this.previousText.delete(taskId);
        }, 'history-push');

        this.currentKanban.cols[columnIdx].tasks[taskIdx].text = newText;

        this.endChange(true, this.taskTextUpdater);
    }

    /**
     * Rolls back the current state to the state found at changeHistory[index].
     * @param index index into BoardState's change history that the current state should be rolled back to
     */
    public undoChange(index: number) {
        if (index < 0 || index >= this.history.length) {
            return;
        }

        this.history.push({
            change: StateChanges.HISTORY_REVERSED,
            data: clone(this.currentKanban),
            details: `Changes reversed to item ${index + 1}`,
        });

        const newKanban = clone(this.history[index].data);
        this.currentKanban = newKanban;

        this.endChange(true);
    }

    /**
     * Save a given StrictKanbanJSON or, if no kanban is provided, the BoardStates' current state.
     * @param kanban StrictKanbanJSON to save
     */
    public save(kanban: StrictKanbanJSON | null = null) {
        if (kanban) {
            this.history.push({
                change: StateChanges.BOARD_LOADED,
                data: clone(this.currentKanban),
                details: '',
            });

            this.currentKanban = clone(kanban);
            this.historyUpdateListeners.forEach((listener) =>
                listener(this.history[this.history.length - 1])
            );
            this.refreshKanban();
        }

        this.vscodeHandler.save(this.currentKanban);
    }

    /**
     * @returns a copy of the BoardState's current state
     */
    public getCurrentState() {
        return clone(this.currentKanban);
    }

    /**
     * Make the kanban-change listeners load a given StrictKanbanJSON
     * @param kanban StrictKanbanJSON to load
     */
    public fakeRefresh(kanban: StrictKanbanJSON) {
        this.kanbanChangeListeners.forEach((listener) => listener(kanban));
    }

    /*******************
     * Private Methods *
     *******************/

    private vscodeHandler;
    private currentKanban = createStrictKanbanJson();
    private kanbanChangeListeners: Array<(kanban: StrictKanbanJSON) => void> =
        [];
    private historyUpdateListeners: Array<
        (historyStep: HistoryObject) => void
    > = [];

    private history: HistoryObject[] = [];

    private loadFromVscode = (kanban: StrictKanbanJSON) => {
        this.currentKanban = kanban;
        this.refreshKanban();
    };

    private getColumnIndex(columnId: string): number {
        return this.currentKanban.cols.findIndex((col) => col.id === columnId);
    }

    private endChange(
        updateHistory: boolean,
        updater: DelayedUpdater | null = null
    ) {
        const save = this.currentKanban.autosave
            ? () => this.vscodeHandler.save(this.currentKanban)
            : () => undefined;

        const doUpdateHistory = updateHistory
            ? () =>
                  this.historyUpdateListeners.forEach((listener) =>
                      listener(this.history[this.history.length - 1])
                  )
            : () => undefined;

        if (updater) {
            updater.tryUpdate(doUpdateHistory, 'history');
            save();
        } else {
            doUpdateHistory();
            save();
        }

        this.refreshKanban();
    }

    private taskTextUpdater = new DelayedUpdater(3000);
    private boardTextUpdater = new DelayedUpdater(1000);
    private columnTextUpdater = new DelayedUpdater(1000);

    private previousText: Map<string, string> = new Map();
}

export default new BoardState();
