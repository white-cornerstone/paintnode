//! Native application menu construction.

use tauri::menu::Menu;
use tauri::menu::MenuItem;
use tauri::menu::PredefinedMenuItem;
use tauri::menu::Submenu;
use tauri::AppHandle;

pub(crate) fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let document_menu_enabled = false;
    let layer_menu_enabled = false;
    let selection_menu_enabled = false;
    let history_menu_enabled = false;
    let viewport_menu_enabled = false;

    let new = MenuItem::with_id(app, "app:new", "New...", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "app:open", "Open...", true, Some("CmdOrCtrl+O"))?;
    let close_document = MenuItem::with_id(
        app,
        "app:close-document",
        "Close Document",
        document_menu_enabled,
        Some("CmdOrCtrl+W"),
    )?;
    let place = MenuItem::with_id(
        app,
        "app:place-image",
        "Place Image...",
        document_menu_enabled,
        None::<&str>,
    )?;
    let save = MenuItem::with_id(
        app,
        "app:save-ora",
        "Save",
        document_menu_enabled,
        Some("CmdOrCtrl+S"),
    )?;
    let save_copy = MenuItem::with_id(
        app,
        "app:save-copy-ora",
        "Save a Copy...",
        document_menu_enabled,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let export = MenuItem::with_id(
        app,
        "app:export-png",
        "Export PNG...",
        document_menu_enabled,
        None::<&str>,
    )?;
    let export_psd = MenuItem::with_id(
        app,
        "app:export-psd",
        "Export PSD...",
        document_menu_enabled,
        None::<&str>,
    )?;

    let undo = MenuItem::with_id(
        app,
        "app:undo",
        "Undo",
        history_menu_enabled,
        Some("CmdOrCtrl+Z"),
    )?;
    let redo = MenuItem::with_id(
        app,
        "app:redo",
        "Redo",
        history_menu_enabled,
        Some("CmdOrCtrl+Shift+Z"),
    )?;
    let cut = PredefinedMenuItem::cut(app, Some("Cut"))?;
    let copy = PredefinedMenuItem::copy(app, Some("Copy"))?;
    let paste = PredefinedMenuItem::paste(app, Some("Paste"))?;
    let fill_fg = MenuItem::with_id(
        app,
        "app:fill-foreground",
        "Fill with Foreground",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let fill_bg = MenuItem::with_id(
        app,
        "app:fill-background",
        "Fill with Background",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let clear = MenuItem::with_id(
        app,
        "app:clear",
        "Clear",
        layer_menu_enabled,
        Some("Delete"),
    )?;
    let free_transform = MenuItem::with_id(
        app,
        "app:free-transform",
        "Free Transform",
        layer_menu_enabled,
        Some("CmdOrCtrl+T"),
    )?;

    let image_size = MenuItem::with_id(
        app,
        "app:image-size",
        "Image Size...",
        document_menu_enabled,
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let canvas_size = MenuItem::with_id(
        app,
        "app:canvas-size",
        "Canvas Size...",
        document_menu_enabled,
        Some("CmdOrCtrl+Alt+C"),
    )?;
    let image_ai_upscale = MenuItem::with_id(
        app,
        "app:image-ai-upscale",
        "AI Upscale...",
        document_menu_enabled,
        Some("CmdOrCtrl+Alt+Shift+U"),
    )?;
    let reveal_all = MenuItem::with_id(
        app,
        "app:reveal-all",
        "Reveal All",
        document_menu_enabled,
        None::<&str>,
    )?;
    let crop = MenuItem::with_id(
        app,
        "app:crop-to-selection",
        "Crop",
        selection_menu_enabled,
        None::<&str>,
    )?;
    let trim = MenuItem::with_id(
        app,
        "app:trim",
        "Trim...",
        document_menu_enabled,
        None::<&str>,
    )?;
    let duplicate_document = MenuItem::with_id(
        app,
        "app:duplicate-document",
        "Duplicate...",
        document_menu_enabled,
        None::<&str>,
    )?;
    let rotate_cw = MenuItem::with_id(
        app,
        "app:rotate-cw",
        "90° Clockwise",
        document_menu_enabled,
        None::<&str>,
    )?;
    let rotate_ccw = MenuItem::with_id(
        app,
        "app:rotate-ccw",
        "90° Counter Clockwise",
        document_menu_enabled,
        None::<&str>,
    )?;
    let rotate_180 = MenuItem::with_id(
        app,
        "app:rotate-180",
        "180°",
        document_menu_enabled,
        None::<&str>,
    )?;
    let flip_h = MenuItem::with_id(
        app,
        "app:flip-horizontal",
        "Flip Canvas Horizontal",
        document_menu_enabled,
        None::<&str>,
    )?;
    let flip_v = MenuItem::with_id(
        app,
        "app:flip-vertical",
        "Flip Canvas Vertical",
        document_menu_enabled,
        None::<&str>,
    )?;
    let brightness = MenuItem::with_id(
        app,
        "app:brightness-contrast",
        "Brightness/Contrast...",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let levels = MenuItem::with_id(
        app,
        "app:levels",
        "Levels...",
        layer_menu_enabled,
        Some("CmdOrCtrl+L"),
    )?;
    let hue = MenuItem::with_id(
        app,
        "app:hue-saturation",
        "Hue/Saturation...",
        layer_menu_enabled,
        Some("CmdOrCtrl+U"),
    )?;
    let threshold = MenuItem::with_id(
        app,
        "app:threshold",
        "Threshold...",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let ai_auto_tone = MenuItem::with_id(
        app,
        "app:ai-auto-tone",
        "Auto Tone",
        document_menu_enabled,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let ai_auto_contrast = MenuItem::with_id(
        app,
        "app:ai-auto-contrast",
        "Auto Contrast",
        document_menu_enabled,
        Some("CmdOrCtrl+Alt+Shift+L"),
    )?;
    let ai_auto_color = MenuItem::with_id(
        app,
        "app:ai-auto-color",
        "Auto Color",
        document_menu_enabled,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let desaturate = MenuItem::with_id(
        app,
        "app:desaturate",
        "Desaturate",
        layer_menu_enabled,
        Some("CmdOrCtrl+Shift+U"),
    )?;
    let invert = MenuItem::with_id(
        app,
        "app:invert",
        "Invert",
        layer_menu_enabled,
        Some("CmdOrCtrl+I"),
    )?;
    let flatten = MenuItem::with_id(
        app,
        "app:flatten",
        "Flatten Image",
        document_menu_enabled,
        None::<&str>,
    )?;

    let new_layer = MenuItem::with_id(
        app,
        "app:new-layer",
        "New Layer",
        document_menu_enabled,
        None::<&str>,
    )?;
    let duplicate_layer = MenuItem::with_id(
        app,
        "app:duplicate-layer",
        "Duplicate Layer",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let delete_layer = MenuItem::with_id(
        app,
        "app:delete-layer",
        "Delete Layer",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let merge_down = MenuItem::with_id(
        app,
        "app:merge-down",
        "Merge Down",
        layer_menu_enabled,
        Some("CmdOrCtrl+E"),
    )?;

    let select_all = MenuItem::with_id(
        app,
        "app:select-all",
        "All",
        document_menu_enabled,
        Some("CmdOrCtrl+A"),
    )?;
    let deselect = MenuItem::with_id(
        app,
        "app:deselect",
        "Deselect",
        selection_menu_enabled,
        Some("CmdOrCtrl+D"),
    )?;
    let inverse = MenuItem::with_id(
        app,
        "app:inverse-selection",
        "Inverse",
        selection_menu_enabled,
        Some("CmdOrCtrl+Shift+I"),
    )?;

    let gaussian = MenuItem::with_id(
        app,
        "app:gaussian-blur",
        "Gaussian Blur...",
        layer_menu_enabled,
        None::<&str>,
    )?;
    let sharpen = MenuItem::with_id(
        app,
        "app:sharpen",
        "Sharpen",
        layer_menu_enabled,
        None::<&str>,
    )?;
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
        layer_menu_enabled,
        None::<&str>,
    )?;
    let ai_upscale = MenuItem::with_id(
        app,
        "app:ai-upscale",
        "Upscale...",
        document_menu_enabled,
        None::<&str>,
    )?;
    let workflow_board = MenuItem::with_id(
        app,
        "app:workflow-board",
        "New Workflow Board",
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        "app:zoom-in",
        "Zoom In",
        viewport_menu_enabled,
        Some("CmdOrCtrl+="),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        "app:zoom-out",
        "Zoom Out",
        viewport_menu_enabled,
        Some("CmdOrCtrl+-"),
    )?;
    let fit = MenuItem::with_id(
        app,
        "app:fit-screen",
        "Fit on Screen",
        viewport_menu_enabled,
        Some("CmdOrCtrl+0"),
    )?;
    let actual = MenuItem::with_id(
        app,
        "app:actual-pixels",
        "Actual Pixels (100%)",
        viewport_menu_enabled,
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
    let adjustments = Submenu::with_id_and_items(
        app,
        "app:image-adjustments",
        "Adjustments",
        layer_menu_enabled,
        &[
            &brightness,
            &levels,
            &hue,
            &threshold,
            &PredefinedMenuItem::separator(app)?,
            &invert,
            &PredefinedMenuItem::separator(app)?,
            &desaturate,
        ],
    )?;
    let image_rotation = Submenu::with_id_and_items(
        app,
        "app:image-rotation",
        "Image Rotation",
        document_menu_enabled,
        &[
            &rotate_180,
            &rotate_cw,
            &rotate_ccw,
            &PredefinedMenuItem::separator(app)?,
            &flip_h,
            &flip_v,
        ],
    )?;
    let image = Submenu::with_items(
        app,
        "Image",
        true,
        &[
            &adjustments,
            &PredefinedMenuItem::separator(app)?,
            &ai_auto_tone,
            &ai_auto_contrast,
            &ai_auto_color,
            &PredefinedMenuItem::separator(app)?,
            &image_size,
            &image_ai_upscale,
            &canvas_size,
            &image_rotation,
            &crop,
            &trim,
            &reveal_all,
            &PredefinedMenuItem::separator(app)?,
            &duplicate_document,
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
            &flatten,
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
            &ai_upscale,
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
