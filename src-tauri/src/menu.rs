//! Native application menu construction.

use tauri::menu::Menu;
use tauri::menu::MenuItem;
use tauri::menu::PredefinedMenuItem;
use tauri::menu::Submenu;
use tauri::AppHandle;

pub(crate) fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new = MenuItem::with_id(app, "app:new", "New...", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "app:open", "Open...", true, Some("CmdOrCtrl+O"))?;
    let close_document = MenuItem::with_id(
        app,
        "app:close-document",
        "Close Document",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let place = MenuItem::with_id(app, "app:place-image", "Place Image...", true, None::<&str>)?;
    let save = MenuItem::with_id(app, "app:save-ora", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_copy = MenuItem::with_id(
        app,
        "app:save-copy-ora",
        "Save a Copy...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let export = MenuItem::with_id(
        app,
        "app:export-png",
        "Export PNG...",
        true,
        Some("CmdOrCtrl+E"),
    )?;
    let export_psd = MenuItem::with_id(app, "app:export-psd", "Export PSD...", true, None::<&str>)?;

    let undo = MenuItem::with_id(app, "app:undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, "app:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let cut = MenuItem::with_id(app, "app:cut", "Cut", true, Some("CmdOrCtrl+X"))?;
    let copy = MenuItem::with_id(app, "app:copy", "Copy", true, Some("CmdOrCtrl+C"))?;
    let paste = MenuItem::with_id(app, "app:paste", "Paste", true, Some("CmdOrCtrl+V"))?;
    let fill_fg = MenuItem::with_id(
        app,
        "app:fill-foreground",
        "Fill with Foreground",
        true,
        None::<&str>,
    )?;
    let fill_bg = MenuItem::with_id(
        app,
        "app:fill-background",
        "Fill with Background",
        true,
        None::<&str>,
    )?;
    let clear = MenuItem::with_id(app, "app:clear", "Clear", true, Some("Delete"))?;
    let free_transform = MenuItem::with_id(
        app,
        "app:free-transform",
        "Free Transform",
        true,
        Some("CmdOrCtrl+T"),
    )?;

    let image_size = MenuItem::with_id(app, "app:image-size", "Image Size...", true, None::<&str>)?;
    let reveal_all = MenuItem::with_id(app, "app:reveal-all", "Reveal All", true, None::<&str>)?;
    let crop = MenuItem::with_id(
        app,
        "app:crop-to-selection",
        "Crop to Selection",
        true,
        None::<&str>,
    )?;
    let rotate_cw = MenuItem::with_id(app, "app:rotate-cw", "Rotate 90° CW", true, None::<&str>)?;
    let rotate_ccw =
        MenuItem::with_id(app, "app:rotate-ccw", "Rotate 90° CCW", true, None::<&str>)?;
    let rotate_180 = MenuItem::with_id(app, "app:rotate-180", "Rotate 180°", true, None::<&str>)?;
    let flip_h = MenuItem::with_id(
        app,
        "app:flip-horizontal",
        "Flip Horizontal",
        true,
        None::<&str>,
    )?;
    let flip_v = MenuItem::with_id(
        app,
        "app:flip-vertical",
        "Flip Vertical",
        true,
        None::<&str>,
    )?;
    let brightness = MenuItem::with_id(
        app,
        "app:brightness-contrast",
        "Brightness/Contrast...",
        true,
        None::<&str>,
    )?;
    let hue = MenuItem::with_id(
        app,
        "app:hue-saturation",
        "Hue/Saturation...",
        true,
        None::<&str>,
    )?;
    let desaturate = MenuItem::with_id(app, "app:desaturate", "Desaturate", true, None::<&str>)?;
    let invert = MenuItem::with_id(app, "app:invert", "Invert", true, Some("CmdOrCtrl+I"))?;
    let flatten = MenuItem::with_id(app, "app:flatten", "Flatten Image", true, None::<&str>)?;

    let new_layer = MenuItem::with_id(app, "app:new-layer", "New Layer", true, None::<&str>)?;
    let duplicate_layer = MenuItem::with_id(
        app,
        "app:duplicate-layer",
        "Duplicate Layer",
        true,
        None::<&str>,
    )?;
    let delete_layer =
        MenuItem::with_id(app, "app:delete-layer", "Delete Layer", true, None::<&str>)?;
    let merge_down = MenuItem::with_id(app, "app:merge-down", "Merge Down", true, None::<&str>)?;

    let select_all = MenuItem::with_id(app, "app:select-all", "All", true, Some("CmdOrCtrl+A"))?;
    let deselect = MenuItem::with_id(app, "app:deselect", "Deselect", true, Some("CmdOrCtrl+D"))?;
    let inverse = MenuItem::with_id(
        app,
        "app:inverse-selection",
        "Inverse",
        true,
        Some("CmdOrCtrl+Shift+I"),
    )?;

    let gaussian = MenuItem::with_id(
        app,
        "app:gaussian-blur",
        "Gaussian Blur...",
        true,
        None::<&str>,
    )?;
    let sharpen = MenuItem::with_id(app, "app:sharpen", "Sharpen", true, None::<&str>)?;
    let ai_generate = MenuItem::with_id(
        app,
        "app:ai-generate",
        "Generate Image...",
        true,
        None::<&str>,
    )?;
    let ai_decouple = MenuItem::with_id(
        app,
        "app:ai-decouple",
        "Extract Assets...",
        true,
        None::<&str>,
    )?;
    let workflow_board = MenuItem::with_id(
        app,
        "app:workflow-board",
        "New Workflow Board",
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(app, "app:zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "app:zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let fit = MenuItem::with_id(
        app,
        "app:fit-screen",
        "Fit on Screen",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let actual = MenuItem::with_id(
        app,
        "app:actual-pixels",
        "Actual Pixels (100%)",
        true,
        Some("CmdOrCtrl+1"),
    )?;
    let about = MenuItem::with_id(app, "app:about", "About PaintNode", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        "app:settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let app_check_updates = MenuItem::with_id(
        app,
        "app:check-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "app:quit", "Quit PaintNode", true, Some("CmdOrCtrl+Q"))?;

    let app_menu = Submenu::with_items(
        app,
        "PaintNode",
        true,
        &[
            &about,
            &settings,
            &app_check_updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new,
            &open,
            &place,
            &PredefinedMenuItem::separator(app)?,
            &save,
            &save_copy,
            &export,
            &export_psd,
            &PredefinedMenuItem::separator(app)?,
            &close_document,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &PredefinedMenuItem::separator(app)?,
            &fill_fg,
            &fill_bg,
            &clear,
            &PredefinedMenuItem::separator(app)?,
            &free_transform,
        ],
    )?;
    let image = Submenu::with_items(
        app,
        "Image",
        true,
        &[
            &image_size,
            &reveal_all,
            &crop,
            &PredefinedMenuItem::separator(app)?,
            &rotate_cw,
            &rotate_ccw,
            &rotate_180,
            &flip_h,
            &flip_v,
            &PredefinedMenuItem::separator(app)?,
            &brightness,
            &hue,
            &desaturate,
            &invert,
            &PredefinedMenuItem::separator(app)?,
            &flatten,
        ],
    )?;
    let layer = Submenu::with_items(
        app,
        "Layer",
        true,
        &[
            &new_layer,
            &duplicate_layer,
            &delete_layer,
            &PredefinedMenuItem::separator(app)?,
            &merge_down,
        ],
    )?;
    let select = Submenu::with_items(app, "Select", true, &[&select_all, &deselect, &inverse])?;
    let filter = Submenu::with_items(app, "Filter", true, &[&gaussian, &sharpen])?;
    let ai = Submenu::with_items(
        app,
        "AI",
        true,
        &[
            &ai_generate,
            &ai_decouple,
            &PredefinedMenuItem::separator(app)?,
            &workflow_board,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &fit, &actual])?;
    Menu::with_items(
        app,
        &[
            &app_menu, &file, &edit, &image, &layer, &select, &filter, &ai, &view,
        ],
    )
}
